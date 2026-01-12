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
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
	type AIResult struct {
		ShortCaption     string `json:"short_caption"`
		DeepDive         string `json:"deep_dive"`
		AudioURL         string `json:"audio_url,omitempty"`
		DeepDiveAudioURL string `json:"deep_dive_audio_url,omitempty"`
	}
	var result AIResult

	// Try unmarshalling as a single object first
	if err := json.Unmarshal([]byte(jsonText), &result); err != nil {
		// If that fails, try unmarshalling as an array of objects
		var arrayResult []AIResult
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

	// 6. Generate Speech using OpenAI (TTS)
	// We do this for the short caption as it's the primary narration
	speechData, err := GenerateSpeech(result.ShortCaption)
	if err != nil || len(speechData) == 0 {
		log.Printf("Warning: Failed to generate speech (err=%v, len=%d)", err, len(speechData))
		// Don't fail the whole request if TTS fails, just continue without audio
	} else {
		// 7. Upload Audio to S3
		audioKey := fmt.Sprintf("staging/tts/%d.mp3", time.Now().UnixNano())
		err = UploadToS3(ctx, audioKey, speechData, "audio/mpeg")
		if err != nil {
			log.Printf("Warning: Failed to upload audio to S3: %v", err)
		} else {
			// For the preview in Companion app, we can generate a fresh presigned URL here.
			cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
			s3Client := s3.NewFromConfig(cfg)
			presignClient := s3.NewPresignClient(s3Client)

			presignedRes, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String("mirror-uploads-sparago-2026"),
				Key:    aws.String(audioKey),
			})
			if err == nil {
				result.AudioURL = presignedRes.URL
				log.Printf("Generated TTS and stored at: %s", audioKey)
			}
		}
	}

	// 8. Generate Speech for Deep Dive
	deepDiveSpeechData, err := GenerateSpeech(result.DeepDive)
	if err != nil || len(deepDiveSpeechData) == 0 {
		log.Printf("Warning: Failed to generate deep dive speech (err=%v, len=%d)", err, len(deepDiveSpeechData))
	} else {
		// 9. Upload Deep Dive Audio to S3
		deepDiveAudioKey := fmt.Sprintf("staging/tts/deepdive_%d.mp3", time.Now().UnixNano())
		err = UploadToS3(ctx, deepDiveAudioKey, deepDiveSpeechData, "audio/mpeg")
		if err != nil {
			log.Printf("Warning: Failed to upload deep dive audio to S3: %v", err)
		} else {
			cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
			s3Client := s3.NewFromConfig(cfg)
			presignClient := s3.NewPresignClient(s3Client)

			presignedRes, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String("mirror-uploads-sparago-2026"),
				Key:    aws.String(deepDiveAudioKey),
			})
			if err == nil {
				result.DeepDiveAudioURL = presignedRes.URL
				log.Printf("Generated Deep Dive TTS and stored at: %s", deepDiveAudioKey)
			}
		}
	}

	// Return JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Error encoding JSON response: %v", err)
		http.Error(w, "Failed to encode response", 500)
		return
	}
}
