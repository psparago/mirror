package functions

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// SearchUnsplash proxies requests to Unsplash to keep the Access Key hidden.
func SearchUnsplash(w http.ResponseWriter, r *http.Request) {
	// 1. Standard CORS handshake
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		return
	}

	// 1. Get the key from Environment Variables
	unsplashKey := os.Getenv("UNSPLASH_ACCESS_KEY")
	if unsplashKey == "" {
		http.Error(w, "Server configuration error: Missing API Key", 500)
		return
	}

	// 2. Extract the search query
	query := r.URL.Query().Get("query")
	if query == "" {
		http.Error(w, "Query parameter is required", http.StatusBadRequest)
		return
	}

	// 3. Prepare the request to Unsplash
	// Use your Access Key here. In the future, we can move this to an Env Var.
	url := fmt.Sprintf("https://api.unsplash.com/search/photos?query=%s&per_page=20&orientation=squarish", query)

	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Client-ID "+unsplashKey)
	req.Header.Set("Accept-Version", "v1")

	// 4. Execute the call
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Unsplash API error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	// 5. Pipe the response back to the Companion App
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
