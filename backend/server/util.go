package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func atoi(r *http.Request, key string) int {
	v, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return -1
	}
	return v
}

func readAll(r io.Reader) ([]byte, error) { return io.ReadAll(r) }
