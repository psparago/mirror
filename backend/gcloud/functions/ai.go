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

	model := client.GenerativeModel("gemini-2.5-flash-lite")

	// 2. Get params
	explorerID := getExplorerID(r)
	if explorerID == "" {
		http.Error(w, "explorer_id is required", 400)
		return
	}
	explorerName := getExplorerName(explorerID)

	imageURL := r.URL.Query().Get("image_url")
	targetCaption := r.URL.Query().Get("target_caption")
	targetDeepDive := r.URL.Query().Get("target_deep_dive")

	var result struct {
		ShortCaption     string `json:"short_caption"`
		DeepDive         string `json:"deep_dive"`
		AudioURL         string `json:"audio_url,omitempty"`
		DeepDiveAudioURL string `json:"deep_dive_audio_url,omitempty"`
	}

	// 3. Logic: If we have both target texts, just do TTS. If missing either, call Gemini for image analysis.
	if targetCaption != "" && targetDeepDive != "" {
		log.Printf("TTS-only mode: using provided texts")
		result.ShortCaption = targetCaption
		result.DeepDive = targetDeepDive
	} else {
		if imageURL == "" {
			http.Error(w, "image_url parameter required if target texts are missing", 400)
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

		// Create multimodal input
		promptText := fmt.Sprintf(`Analyze this image for a 15-year-old with Angelman Syndrome (%s). 
IMPORTANT: DO NOT attempt to diagnose or guess if anyone in the photo has a medical disorder or syndrome (like Down Syndrome or Angelman Syndrome) based on their appearance, facial expressions, or gestures. Focus only on the observable activities, objects, and emotions.

Return a SINGLE JSON object containing:
"short_caption": A high-impact greeting (max 10 words).
"deep_dive": A 2-3 sentence story about details in the photo.
Format: {"short_caption": "string", "deep_dive": "string"}`, explorerName)

		parts := []genai.Part{
			genai.Text(promptText),
			genai.ImageData("jpeg", imgData),
		}

		resp, err := model.GenerateContent(ctx, parts...)
		if err != nil {
			http.Error(w, "Gemini Error: "+err.Error(), 500)
			return
		}

		if len(resp.Candidates) == 0 {
			http.Error(w, "No response from Gemini", 500)
			return
		}

		part := resp.Candidates[0].Content.Parts[0]
		var text string
		if v, ok := part.(genai.Text); ok {
			text = string(v)
		} else {
			http.Error(w, "Unexpected response type", 500)
			return
		}

		jsonText := strings.TrimSpace(text)
		jsonText = strings.TrimPrefix(jsonText, "```json")
		jsonText = strings.TrimPrefix(jsonText, "```")
		jsonText = strings.TrimSuffix(jsonText, "```")
		jsonText = strings.TrimSpace(jsonText)

		if err := json.Unmarshal([]byte(jsonText), &result); err != nil {
			http.Error(w, "JSON Parse Error", 500)
			return
		}

		// Preference: If user provided one but not both, use their text
		if targetCaption != "" {
			result.ShortCaption = targetCaption
		}
		if targetDeepDive != "" {
			result.DeepDive = targetDeepDive
		}
	}

	// Setup AWS Config for TTS storage (shared)
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		log.Printf("AWS Config Error: %v", err)
		http.Error(w, "S3 Config Error", 500)
		return
	}
	s3Client := s3.NewFromConfig(cfg)
	presignClient := s3.NewPresignClient(s3Client)

	// 6. Generate Speech using OpenAI (TTS)
	if result.ShortCaption != "" {
		log.Printf("TTS: Generating speech for caption: %s", result.ShortCaption)
		speechData, err := GenerateSpeech(result.ShortCaption)
		if err == nil && len(speechData) > 0 {
			audioKey := fmt.Sprintf("staging/%s/tts/%d.mp3", explorerID, time.Now().UnixNano())

			err = UploadToS3(ctx, audioKey, speechData, "audio/mpeg")
			if err == nil {
				presignedRes, _ := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
					Bucket: aws.String("mirror-uploads-sparago-2026"),
					Key:    aws.String(audioKey),
				})
				result.AudioURL = presignedRes.URL
				log.Printf("Generated TTS for caption at: %s", audioKey)
			}
		}
	}

	// 8. Generate Speech for Deep Dive
	if result.DeepDive != "" {
		log.Printf("TTS: Generating speech for deep dive: %s", result.DeepDive)
		deepDiveSpeechData, err := GenerateSpeech(result.DeepDive)
		if err == nil && len(deepDiveSpeechData) > 0 {
			deepDiveAudioKey := fmt.Sprintf("staging/%s/tts/deepdive_%d.mp3", explorerID, time.Now().UnixNano())

			err = UploadToS3(ctx, deepDiveAudioKey, deepDiveSpeechData, "audio/mpeg")
			if err == nil {
				presignedRes, _ := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
					Bucket: aws.String("mirror-uploads-sparago-2026"),
					Key:    aws.String(deepDiveAudioKey),
				})
				result.DeepDiveAudioURL = presignedRes.URL
				log.Printf("Generated Deep Dive TTS at: %s", deepDiveAudioKey)
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
