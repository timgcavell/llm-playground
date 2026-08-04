package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// maxBody caps a request. Unbounded reads are how one client makes the server
// everyone else shares run out of memory.
const maxBody = 1 << 20

func readLimited(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, maxBody))
}

func isArray(raw []byte) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
