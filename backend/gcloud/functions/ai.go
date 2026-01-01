package functions

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

func GenerateAIDescription(w http.ResponseWriter, r *http.Request) {
	// 1. CORS Headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		return
	}

	// 2. Setup Gemini Client
	ctx := context.Background()
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		http.Error(w, "GEMINI_API_KEY not configured", 500)
		return
	}

	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		http.Error(w, "Failed to create Gemini client: "+err.Error(), 500)
		return
	}
	defer client.Close()

	model := client.GenerativeModel("gemini-2.5-flash")

	// 2. Get Image from S3 URL (passed in query)
	imageURL := r.URL.Query().Get("image_url")
	if imageURL == "" {
		http.Error(w, "image_url parameter required", 400)
		return
	}

	res, err := http.Get(imageURL)
	if err != nil {
		http.Error(w, "Failed to fetch image: "+err.Error(), 500)
		return
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("Failed to fetch image: HTTP %d", res.StatusCode), 500)
		return
	}

	imgData, err := io.ReadAll(res.Body)
	if err != nil {
		http.Error(w, "Failed to read image data: "+err.Error(), 500)
		return
	}

	// 3. Create multimodal input using genai.Part interface
	// The prompt for Cole
	promptText := "Analyze this image. Write a friendly, 1-sentence description for a 15-year-old named Cole who has Angelman Syndrome. Focus on the main object. Example: 'Look Cole, it's a big red fire truck!'"

	// Use Part interface for multimodal inputs (2026 SDK update)
	parts := []genai.Part{
		genai.Text(promptText),
		genai.ImageData("jpeg", imgData),
	}

	// 4. Ask Gemini
	resp, err := model.GenerateContent(ctx, parts...)
	if err != nil {
		http.Error(w, "Generate AI Description Error: "+err.Error(), 500)
		return
	}

	// 5. Return the text
	if len(resp.Candidates) == 0 {
		log.Printf("Error: No candidates in response")
		http.Error(w, "No response from Gemini", 500)
		return
	}

	if len(resp.Candidates[0].Content.Parts) == 0 {
		log.Printf("Error: No parts in response")
		http.Error(w, "No response from Gemini", 500)
		return
	}

	// Extract text from the response part
	part := resp.Candidates[0].Content.Parts[0]
	log.Printf("Response part type: %T", part)

	var text string
	switch v := part.(type) {
	case genai.Text:
		text = string(v)
		log.Printf("Extracted text: %s", text)
	default:
		log.Printf("Error: Unexpected response type from Gemini: %T, value: %v", part, part)
		http.Error(w, fmt.Sprintf("Unexpected response type from Gemini: %T", part), 500)
		return
	}

	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprint(w, text)
}
