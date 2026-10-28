// Downloads NParks path data from data.gov.sg and writes compact copies for the website:
//
//	data/tracks.js  every NParks path (park connectors + paths inside parks), used for routing
//	data/pcn.js     the named PCN loops, used for the Explore tab
//
// Usage (from the project folder):
//
//	go run scripts/build-data.go
//	go run scripts/build-data.go -tracks tracks.geojson -loops loops.geojson   (use downloaded files)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	tracksID = "d_306cc1018cb733346681883ee6d73054" // NParks Tracks
	loopsID  = "d_a69ef89737379f231d2ae93fd1c5707f" // Park Connector Loop

	simplifyMetres = 1.5 // drop points that change a line's shape by less than this
)

type feature struct {
	Geometry struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	} `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

type collection struct {
	Features []feature `json:"features"`
}

type outFeature struct {
	Type     string         `json:"type"`
	Geometry outGeometry    `json:"geometry"`
	Props    map[string]any `json:"properties"`
}

type outGeometry struct {
	Type        string `json:"type"`
	Coordinates any    `json:"coordinates"`
}

type point = [2]float64

func main() {
	tracksFile := flag.String("tracks", "", "read NParks Tracks from this GeoJSON file instead of downloading")
	loopsFile := flag.String("loops", "", "read Park Connector Loop from this GeoJSON file instead of downloading")
	flag.Parse()

	tracks := must(load(tracksID, *tracksFile))
	loops := must(load(loopsID, *loopsFile))

	var trackOut []outFeature
	for _, f := range tracks.Features {
		p := f.Properties
		props := map[string]any{
			"name": cleanName(str(p["PARK"])),
			"pc":   str(p["PARK_TYPE"]) == "Park Connector",
			"bike": str(p["ALLOW_CYCLING"]) != "N",
			"type": str(p["TYPE"]),
		}
		for _, line := range lines(f) {
			trackOut = append(trackOut, lineFeature(line, props))
		}
	}

	var loopOut []outFeature
	for _, f := range loops.Features {
		props := map[string]any{
			"PARK":     cleanName(str(f.Properties["PARK"])),
			"PCN_LOOP": str(f.Properties["PCN_LOOP"]),
		}
		for _, line := range lines(f) {
			loopOut = append(loopOut, lineFeature(line, props))
		}
	}

	today := time.Now().Format("2006-01-02")
	write("data/tracks.js", "TRACKS_DATA", trackOut, fmt.Sprintf("NParks Tracks, data.gov.sg (%s). Downloaded %s.", tracksID, today))
	write("data/pcn.js", "PCN_DATA", loopOut, fmt.Sprintf("NParks Park Connector Loop, data.gov.sg (%s). Downloaded %s.", loopsID, today))
}

func must[T any](v T, err error) T {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	return v
}

// load reads a dataset from a local file, or downloads it from data.gov.sg.
func load(datasetID, file string) (collection, error) {
	var c collection
	var r io.Reader
	if file != "" {
		f, err := os.Open(file)
		if err != nil {
			return c, err
		}
		defer f.Close()
		r = f
	} else {
		fmt.Println("Downloading", datasetID, "...")
		var poll struct {
			Code     int    `json:"code"`
			ErrorMsg string `json:"errorMsg"`
			Data     struct {
				URL string `json:"url"`
			} `json:"data"`
		}
		if err := getJSON("https://api-open.data.gov.sg/v1/public/api/datasets/"+datasetID+"/poll-download", &poll); err != nil {
			return c, err
		}
		if poll.Code != 0 {
			return c, fmt.Errorf("data.gov.sg: %s", poll.ErrorMsg)
		}
		return c, getJSON(poll.Data.URL, &c)
	}
	return c, json.NewDecoder(r).Decode(&c)
}

func getJSON(url string, v any) error {
	res, err := http.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 { // the poll endpoint answers 201
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

// lines returns every line in a LineString or MultiLineString feature.
func lines(f feature) [][]point {
	var out [][]point
	switch f.Geometry.Type {
	case "LineString":
		var l []point
		if json.Unmarshal(f.Geometry.Coordinates, &l) == nil {
			out = append(out, l)
		}
	case "MultiLineString":
		json.Unmarshal(f.Geometry.Coordinates, &out)
	}
	return out
}

func lineFeature(line []point, props map[string]any) outFeature {
	line = simplify(line)
	coords := make([][2]float64, len(line))
	for i, p := range line {
		// 5 decimal places is about 1 m, plenty for a path.
		coords[i] = [2]float64{math.Round(p[0]*1e5) / 1e5, math.Round(p[1]*1e5) / 1e5}
	}
	return outFeature{"Feature", outGeometry{"LineString", coords}, props}
}

// Flat-earth metres, accurate enough for Singapore.
func toMetres(p point) (float64, float64) {
	return p[0] * 111320 * math.Cos(1.35*math.Pi/180), p[1] * 110574
}

// simplify removes points that barely change the line's shape (Douglas-Peucker).
func simplify(line []point) []point {
	if len(line) < 3 {
		return line
	}
	keep := make([]bool, len(line))
	keep[0], keep[len(line)-1] = true, true
	var walk func(a, b int)
	walk = func(a, b int) {
		ax, ay := toMetres(line[a])
		bx, by := toMetres(line[b])
		maxD, maxI := 0.0, -1
		for i := a + 1; i < b; i++ {
			px, py := toMetres(line[i])
			if d := pointToSegment(px, py, ax, ay, bx, by); d > maxD {
				maxD, maxI = d, i
			}
		}
		if maxD > simplifyMetres {
			keep[maxI] = true
			walk(a, maxI)
			walk(maxI, b)
		}
	}
	walk(0, len(line)-1)
	var out []point
	for i, p := range line {
		if keep[i] {
			out = append(out, p)
		}
	}
	return out
}

func pointToSegment(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	t := 0.0
	if l := dx*dx + dy*dy; l > 0 {
		t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l))
	}
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

var (
	word     = regexp.MustCompile(`\b[A-Za-z]+\b`)
	abbrevPK = regexp.MustCompile(`(?i)\bPK\b`)
	abbrevPC = regexp.MustCompile(`(?i)\bPC\b`)
)

// Expressways, towns and agencies that stay in capitals.
var keepUpper = map[string]bool{
	"AYE": true, "BKE": true, "CTE": true, "ECP": true, "KJE": true, "KPE": true, "MCE": true, "PIE": true,
	"SLE": true, "TPE": true, "AMK": true, "HDB": true, "LTA": true, "MRT": true, "PUB": true, "URA": true,
	"NP": true, "NR": true, "PCN": true,
}

// NParks uses internal zone codes for some parks.
var namePrefixes = map[string]string{
	"SBG": "Singapore Botanic Gardens",
	"JLG": "Jurong Lake Gardens",
}

// cleanName turns "BISHAN - ANG MO KIO PK" into "Bishan - Ang Mo Kio Park".
func cleanName(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	for prefix, name := range namePrefixes {
		if strings.HasPrefix(s, prefix+" ") || strings.HasPrefix(s, prefix+":") {
			return name
		}
	}
	if s == strings.ToUpper(s) {
		s = word.ReplaceAllStringFunc(s, func(w string) string {
			if keepUpper[w] {
				return w
			}
			return w[:1] + strings.ToLower(w[1:])
		})
	}
	s = abbrevPK.ReplaceAllString(s, "Park")
	return abbrevPC.ReplaceAllString(s, "Park Connector")
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func write(path, varName string, features []outFeature, source string) {
	data := must(json.Marshal(map[string]any{"type": "FeatureCollection", "features": features}))
	must(0, os.MkdirAll(filepath.Dir(path), 0o755))
	js := fmt.Sprintf("// Source: %s\nwindow.%s = %s;\n", source, varName, data)
	must(0, os.WriteFile(path, []byte(js), 0o644))
	fmt.Printf("Wrote %s (%d paths, %.1f MB)\n", path, len(features), float64(len(js))/1e6)
}
