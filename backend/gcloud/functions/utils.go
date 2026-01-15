package functions

import (
	"net/http"
	"strings"
)

// getExplorerID extracts the explorer_id from query parameters.
func getExplorerID(r *http.Request) string {
	id := r.URL.Query().Get("explorer_id")
	if id == "" {
		id = r.URL.Query().Get("explorerId")
	}
	return id
}

// getExplorerName returns a capitalized version of the explorer_id for use in prompts.
func getExplorerName(explorerID string) string {
	if explorerID == "" {
		return "the explorer"
	}
	// Simple capitalization for now (e.g., "cole" -> "Cole")
	return strings.Title(explorerID)
}
