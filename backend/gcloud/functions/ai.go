package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

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
	// The prompt for Cole - requesting structured JSON response
	promptText := `Analyze this image for a 15-year-old with Angelman Syndrome. Return range SINGLE JSON object containing exactly these two keys:

"short_caption": A brief, high-impact greeting (max 10 words).

"deep_dive": A more detailed, 2-3 sentence story about the details in the photo to facilitate deeper engagement.

Return ONLY valid JSON. No markdown formatting.
Format: {"short_caption": "string", "deep_dive": "string"}`

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

	// 5. Extract and parse JSON response
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

	// Parse JSON response - handle markdown code blocks if present
	jsonText := strings.TrimSpace(text)
	if strings.HasPrefix(jsonText, "```json") {
		jsonText = strings.TrimPrefix(jsonText, "```json")
		jsonText = strings.TrimSuffix(jsonText, "```")
	}
	if strings.HasPrefix(jsonText, "```") {
		jsonText = strings.TrimPrefix(jsonText, "```")
		jsonText = strings.TrimSuffix(jsonText, "```")
	}
	jsonText = strings.TrimSpace(jsonText)

	// Parse JSON
	var result struct {
		ShortCaption string `json:"short_caption"`
		DeepDive     string `json:"deep_dive"`
	}

	// Try unmarshalling as a single object first
	if err := json.Unmarshal([]byte(jsonText), &result); err != nil {
		// If that fails, try unmarshalling as an array of objects
		var arrayResult []struct {
			ShortCaption string `json:"short_caption"`
			DeepDive     string `json:"deep_dive"`
		}
		if errArray := json.Unmarshal([]byte(jsonText), &arrayResult); errArray == nil && len(arrayResult) > 0 {
			// Successfully parsed as array, use the first item
			result = arrayResult[0]
			log.Printf("Parsed JSON as array (fallback success)")
		} else {
			// Both failed
			log.Printf("Error parsing JSON response: %v, raw text: %s", err, text)
			http.Error(w, fmt.Sprintf("Failed to parse JSON response: %v", err), 500)
			return
		}
	}

	// Validate required fields
	if result.ShortCaption == "" || result.DeepDive == "" {
		log.Printf("Error: Missing required fields in JSON response")
		http.Error(w, "Invalid JSON response: missing required fields", 500)
		return
	}

	// Return JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Error encoding JSON response: %v", err)
		http.Error(w, "Failed to encode response", 500)
		return
	}
}
