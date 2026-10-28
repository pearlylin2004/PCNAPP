// Downloads NParks and OpenStreetMap data and writes compact copies for the website:
//
//	data/tracks.js     every NParks path (park connectors + paths inside parks), used for routing
//	data/pcn.js        the named PCN loops, used for the Explore tab
//	data/amenities.js  toilets and drinking water (NParks park facilities + OpenStreetMap)
//
// Usage (from the project folder):
//
//	go run scripts/build-data.go
//	go run scripts/build-data.go -tracks t.geojson -loops l.geojson -facilities f.geojson -osm o.json   (use downloaded files)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	tracksID     = "d_306cc1018cb733346681883ee6d73054" // NParks Tracks
	loopsID      = "d_a69ef89737379f231d2ae93fd1c5707f" // Park Connector Loop
	facilitiesID = "d_14d807e20158338fd578c2913953516e" // NParks Park Facilities

	simplifyMetres = 1.5 // drop points that change a line's shape by less than this
	dedupeMetres   = 30  // an OpenStreetMap amenity this close to an NParks one of the same type is a duplicate

	overpassURL   = "https://overpass-api.de/api/interpreter"
	overpassQuery = `[out:json][timeout:90];area["ISO3166-1"="SG"]->.sg;
(nwr["amenity"="toilets"](area.sg);nwr["amenity"="drinking_water"](area.sg););out center tags;`
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
	facilitiesFile := flag.String("facilities", "", "read NParks Park Facilities from this GeoJSON file instead of downloading")
	osmFile := flag.String("osm", "", "read the OpenStreetMap Overpass result from this JSON file instead of downloading")
	flag.Parse()

	tracks := must(load(tracksID, *tracksFile))
	loops := must(load(loopsID, *loopsFile))
	facilities := must(load(facilitiesID, *facilitiesFile))
	osm := must(loadOSM(*osmFile))

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

	stops := amenities(facilities, osm)

	today := time.Now().Format("2006-01-02")
	write("data/tracks.js", "TRACKS_DATA", featureCollection(trackOut), len(trackOut),
		fmt.Sprintf("NParks Tracks, data.gov.sg (%s). Downloaded %s.", tracksID, today))
	write("data/pcn.js", "PCN_DATA", featureCollection(loopOut), len(loopOut),
		fmt.Sprintf("NParks Park Connector Loop, data.gov.sg (%s). Downloaded %s.", loopsID, today))
	write("data/amenities.js", "AMENITIES", stops, len(stops),
		fmt.Sprintf("NParks Park Facilities, data.gov.sg (%s), and OpenStreetMap contributors (ODbL). Downloaded %s.", facilitiesID, today))
}

func featureCollection(features []outFeature) map[string]any {
	return map[string]any{"type": "FeatureCollection", "features": features}
}

type amenity struct {
	Type   string  `json:"type"` // "toilet" or "water"
	Lat    float64 `json:"lat"`
	Lng    float64 `json:"lng"`
	Name   string  `json:"name,omitempty"`
	Info   string  `json:"info,omitempty"`
	Source string  `json:"src"`
}

type osmResult struct {
	Elements []struct {
		Lat    float64 `json:"lat"`
		Lon    float64 `json:"lon"`
		Center *struct {
			Lat float64 `json:"lat"`
			Lon float64 `json:"lon"`
		} `json:"center"`
		Tags map[string]string `json:"tags"`
	} `json:"elements"`
}

// loadOSM reads toilets and drinking water from a file, or asks the Overpass API.
func loadOSM(file string) (osmResult, error) {
	var r osmResult
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return r, err
		}
		return r, json.Unmarshal(data, &r)
	}
	fmt.Println("Downloading toilets and drinking water from OpenStreetMap ...")
	res, err := http.PostForm(overpassURL, url.Values{"data": {overpassQuery}})
	if err != nil {
		return r, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return r, fmt.Errorf("overpass: %s", res.Status)
	}
	return r, json.NewDecoder(res.Body).Decode(&r)
}

// amenities combines NParks park facilities with OpenStreetMap, dropping duplicates.
func amenities(facilities collection, osm osmResult) []amenity {
	var out []amenity
	for _, f := range facilities.Features {
		var t string
		switch str(f.Properties["CLASS"]) {
		case "TOILET":
			t = "toilet"
		case "DRINKING FOUNTAIN":
			t = "water"
		default:
			continue
		}
		var pt point
		if f.Geometry.Type != "Point" || json.Unmarshal(f.Geometry.Coordinates, &pt) != nil {
			continue
		}
		name := cleanName(str(f.Properties["NAME"]))
		if strings.EqualFold(name, "Toilet") || strings.EqualFold(name, "Drinking Fountain") {
			name = ""
		}
		out = append(out, amenity{t, round5(pt[1]), round5(pt[0]), name, str(f.Properties["ADDITIONAL_INFO"]), "NParks"})
	}
	nparksCount := len(out)

	for _, e := range osm.Elements {
		tags := e.Tags
		if tags["access"] == "private" || tags["access"] == "no" {
			continue
		}
		t := map[string]string{"toilets": "toilet", "drinking_water": "water"}[tags["amenity"]]
		lat, lng := e.Lat, e.Lon
		if e.Center != nil {
			lat, lng = e.Center.Lat, e.Center.Lon
		}
		if t == "" || lat == 0 || nearSameType(out[:nparksCount], t, lat, lng) {
			continue
		}
		var info []string
		if tags["fee"] == "yes" {
			info = append(info, "Paid")
		}
		if tags["access"] == "customers" {
			info = append(info, "For customers")
		}
		if tags["wheelchair"] == "yes" {
			info = append(info, "Wheelchair accessible")
		}
		if h := tags["opening_hours"]; h != "" {
			info = append(info, "Open "+h)
		}
		out = append(out, amenity{t, round5(lat), round5(lng), tags["name"], strings.Join(info, " · "), "OpenStreetMap"})
	}
	return out
}

func nearSameType(list []amenity, t string, lat, lng float64) bool {
	px, py := toMetres(point{lng, lat})
	for _, a := range list {
		ax, ay := toMetres(point{a.Lng, a.Lat})
		if a.Type == t && math.Hypot(px-ax, py-ay) < dedupeMetres {
			return true
		}
	}
	return false
}

func round5(v float64) float64 { return math.Round(v*1e5) / 1e5 }

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
		coords[i] = [2]float64{round5(p[0]), round5(p[1])}
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

func write(path, varName string, value any, count int, source string) {
	data := must(json.Marshal(value))
	must(0, os.MkdirAll(filepath.Dir(path), 0o755))
	js := fmt.Sprintf("// Source: %s\nwindow.%s = %s;\n", source, varName, data)
	must(0, os.WriteFile(path, []byte(js), 0o644))
	fmt.Printf("Wrote %s (%d items, %.1f MB)\n", path, count, float64(len(js))/1e6)
}
