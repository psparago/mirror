package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// extractFirstJSONObject tries to find the first balanced {...} JSON object in s.
// This is a defensive fallback for when the model returns extra prose around JSON.
func extractFirstJSONObject(s string) (string, bool) {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return "", false
	}
	depth := 0
	inString := false
	escape := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inString {
			if escape {
				escape = false
				continue
			}
			if c == '\\' {
				escape = true
				continue
			}
			if c == '"' {
				inString = false
			}
			continue
		}

		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}

func parseGeminiJSONText(text string, dest any) error {
	jsonText := strings.TrimSpace(text)
	jsonText = strings.TrimPrefix(jsonText, "```json")
	jsonText = strings.TrimPrefix(jsonText, "```")
	jsonText = strings.TrimSuffix(jsonText, "```")
	jsonText = strings.TrimSpace(jsonText)

	if err := json.Unmarshal([]byte(jsonText), dest); err == nil {
		return nil
	} else {
		snippet := jsonText
		if len(snippet) > 500 {
			snippet = snippet[:500] + "..."
		}
		log.Printf("JSON Parse Error: %v. Raw snippet: %q", err, snippet)
		if extracted, ok := extractFirstJSONObject(jsonText); ok {
			if err2 := json.Unmarshal([]byte(extracted), dest); err2 != nil {
				return err2
			}
			return nil
		}
		return err
	}
}

func mimeFromMediaKeyOrURL(keyOrURL, contentTypeHint string) string {
	ct := strings.TrimSpace(strings.Split(contentTypeHint, ";")[0])
	if ct != "" && ct != "application/octet-stream" && ct != "binary/octet-stream" {
		// Normalize common audio container types for Gemini.
		switch strings.ToLower(ct) {
		case "audio/m4a", "audio/x-m4a", "audio/mp4":
			return "audio/mp4"
		case "audio/mpeg", "audio/mp3":
			return "audio/mp3"
		case "video/mp4":
			return "video/mp4"
		default:
			return ct
		}
	}
	cleaned := keyOrURL
	if i := strings.Index(cleaned, "?"); i >= 0 {
		cleaned = cleaned[:i]
	}
	ext := strings.ToLower(path.Ext(cleaned))
	switch ext {
	case ".m4a", ".mp4":
		// Ambiguous: narration uses .mp4 video; voice intros use .m4a audio.
		if ext == ".m4a" {
			return "audio/mp4"
		}
		return "video/mp4"
	case ".mp3":
		return "audio/mp3"
	case ".wav":
		return "audio/wav"
	case ".aac":
		return "audio/aac"
	case ".webm":
		return "audio/webm"
	default:
		return "audio/mp4"
	}
}

type spokenContextResult struct {
	RawTranscript    string `json:"raw_transcript"`
	CleanedContext   string `json:"cleaned_context"`
	SuggestedCaption string `json:"suggested_caption"`
}

func extractSpokenContext(
	ctx context.Context,
	model *genai.GenerativeModel,
	mediaData []byte,
	mimeType string,
	explorerName string,
) (*spokenContextResult, error) {
	if len(mediaData) == 0 {
		return nil, fmt.Errorf("empty spoken context media")
	}

	prompt := fmt.Sprintf(
		"You are helping a family Companion describe a photo or video for %s, a teen with Angelman Syndrome.\n"+
			"Listen to the Companion speaking in this recording (uhhs, umms, and false starts are normal).\n\n"+
			"Return a SINGLE JSON object with:\n"+
			`- "raw_transcript": faithful transcript including filler words\n`+
			`- "cleaned_context": concise cleaned facts for an AI captioner — names, pets, places, what is happening. `+
			`Prefer comma-separated style like "Nona, dog Dalton, at the pool". Remove filler words. Do not invent facts.\n`+
			`- "suggested_caption": a warm greeting TO %s about what they said (max 10 words). `+
			`Derive it only from what the Companion said; do not invent people or places.\n\n`+
			`Return ONLY JSON: {"raw_transcript":"...","cleaned_context":"...","suggested_caption":"..."}`,
		explorerName, explorerName,
	)

	parts := []genai.Part{
		genai.Text(prompt),
		genai.Blob{MIMEType: mimeType, Data: mediaData},
	}
	resp, err := model.GenerateContent(ctx, parts...)
	if err != nil {
		return nil, fmt.Errorf("gemini spoken context: %w", err)
	}
	if len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil || len(resp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("no response from Gemini for spoken context")
	}
	part := resp.Candidates[0].Content.Parts[0]
	text, ok := part.(genai.Text)
	if !ok {
		return nil, fmt.Errorf("unexpected spoken context response type")
	}
	var out spokenContextResult
	if err := parseGeminiJSONText(string(text), &out); err != nil {
		return nil, fmt.Errorf("spoken context JSON: %w", err)
	}
	out.RawTranscript = strings.TrimSpace(out.RawTranscript)
	out.CleanedContext = strings.TrimSpace(out.CleanedContext)
	out.SuggestedCaption = strings.TrimSpace(out.SuggestedCaption)
	return &out, nil
}

func augmentPromptWithSpokenContext(prompt, cleanedContext, suggestedCaption string) string {
	cleanedContext = strings.TrimSpace(cleanedContext)
	if cleanedContext == "" {
		return prompt
	}
	var b strings.Builder
	b.WriteString(prompt)
	b.WriteString("\n\nSPOKEN CONTEXT FROM COMPANION (cleaned transcript — TRUST THIS over visual guessing when they conflict):\n")
	b.WriteString(cleanedContext)
	b.WriteString("\nDo NOT invent people, pets, or places the Companion did not mention.")
	if sc := strings.TrimSpace(suggestedCaption); sc != "" {
		b.WriteString("\nPrefer a short_caption close to (max 10 words): ")
		b.WriteString(sc)
	}
	return b.String()
}

func loadSpokenMedia(ctx context.Context, mediaKey, mediaURL string) (data []byte, mime string, err error) {
	mediaKey = strings.TrimSpace(mediaKey)
	mediaURL = strings.TrimSpace(mediaURL)
	if mediaKey != "" {
		// Only allow staging keys for safety.
		if !strings.HasPrefix(mediaKey, "staging/") {
			return nil, "", fmt.Errorf("context_media_key must be under staging/")
		}
		data, ct, dlErr := DownloadFromS3(ctx, mediaKey)
		if dlErr != nil {
			return nil, "", dlErr
		}
		return data, mimeFromMediaKeyOrURL(mediaKey, ct), nil
	}
	if mediaURL == "" {
		return nil, "", fmt.Errorf("context media not provided")
	}
	res, getErr := http.Get(mediaURL)
	if getErr != nil {
		return nil, "", getErr
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("failed to fetch context media: HTTP %d", res.StatusCode)
	}
	data, err = io.ReadAll(res.Body)
	if err != nil {
		return nil, "", err
	}
	return data, mimeFromMediaKeyOrURL(mediaURL, res.Header.Get("Content-Type")), nil
}

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
	clientPrompt := strings.TrimSpace(r.URL.Query().Get("prompt"))
	companionName := strings.TrimSpace(r.URL.Query().Get("companion_name"))
	companionInReflection := r.URL.Query().Get("companion_in_reflection") == "true"
	explorerInReflection := r.URL.Query().Get("explorer_in_reflection") == "true"
	peopleContext := strings.TrimSpace(r.URL.Query().Get("people_context"))
	captionVoice := r.URL.Query().Get("caption_voice")
	deepDiveVoice := r.URL.Query().Get("deep_dive_voice")
	contextMediaKey := strings.TrimSpace(r.URL.Query().Get("context_media_key"))
	contextAudioURL := strings.TrimSpace(r.URL.Query().Get("context_audio_url"))
	skipTTS := r.URL.Query().Get("skip_tts") == "true"
	skipCaptionTTS := skipTTS || r.URL.Query().Get("skip_caption_tts") == "true"

	var result struct {
		ShortCaption       string `json:"short_caption"`
		DeepDive           string `json:"deep_dive"`
		AudioURL           string `json:"audio_url,omitempty"`
		DeepDiveAudioURL   string `json:"deep_dive_audio_url,omitempty"`
		AudioS3Key         string `json:"audio_s3_key,omitempty"`
		DeepDiveAudioS3Key string `json:"deep_dive_audio_s3_key,omitempty"`
		StagingEventID     string `json:"staging_event_id,omitempty"`
		RawTranscript      string `json:"raw_transcript,omitempty"`
		CleanedContext     string `json:"cleaned_context,omitempty"`
		SuggestedCaption   string `json:"suggested_caption,omitempty"`
	}

	// Extract staging event_id from image URL (e.g. .../staging/1738941234567/image.jpg) for client cleanup
	if imageURL != "" {
		if i := strings.Index(imageURL, "staging/"); i >= 0 {
			start := i + len("staging/")
			if end := strings.Index(imageURL[start:], "/image"); end >= 0 {
				result.StagingEventID = imageURL[start : start+end]
			}
		}
	}
	if result.StagingEventID == "" && contextMediaKey != "" {
		// staging/{eventId}/spoken_context.m4a
		rest := strings.TrimPrefix(contextMediaKey, "staging/")
		if slash := strings.Index(rest, "/"); slash > 0 {
			result.StagingEventID = rest[:slash]
		}
	}

	// 2b. Optional spoken context (mic intro or Bring-It-to-Life narration video)
	if contextMediaKey != "" || contextAudioURL != "" {
		mediaData, mime, mediaErr := loadSpokenMedia(ctx, contextMediaKey, contextAudioURL)
		if mediaErr != nil {
			log.Printf("Spoken context media load failed: %v", mediaErr)
			http.Error(w, "Failed to load spoken context media: "+mediaErr.Error(), 500)
			return
		}
		log.Printf("Spoken context: loaded %d bytes as %s", len(mediaData), mime)
		spoken, spokenErr := extractSpokenContext(ctx, model, mediaData, mime, explorerName)
		if spokenErr != nil {
			log.Printf("Spoken context extract failed: %v", spokenErr)
			http.Error(w, "Failed to process spoken context: "+spokenErr.Error(), 500)
			return
		}
		result.RawTranscript = spoken.RawTranscript
		result.CleanedContext = spoken.CleanedContext
		result.SuggestedCaption = spoken.SuggestedCaption
		if peopleContext == "" && spoken.CleanedContext != "" {
			peopleContext = spoken.CleanedContext
		}
		if targetCaption == "" && spoken.SuggestedCaption != "" {
			targetCaption = spoken.SuggestedCaption
		}
		if clientPrompt != "" {
			clientPrompt = augmentPromptWithSpokenContext(clientPrompt, spoken.CleanedContext, spoken.SuggestedCaption)
		}
		log.Printf("Spoken context OK: cleaned=%q suggested=%q", spoken.CleanedContext, spoken.SuggestedCaption)
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

		// Use client-provided prompt if available; otherwise fall back to
		// server-side construction (backwards compat for older app versions).
		var promptText string
		if clientPrompt != "" {
			promptText = clientPrompt
			log.Printf("Using client-provided prompt (%d chars)", len(clientPrompt))
		} else {
			log.Printf("No client prompt — using legacy server-side prompt builder")
			var contextLines []string
			if companionName != "" && companionInReflection {
				contextLines = append(contextLines, fmt.Sprintf("%s is the sender and has confirmed they appear in the image.", companionName))
			} else if companionName != "" {
				contextLines = append(contextLines, fmt.Sprintf("%s is the sender of this Reflection.", companionName))
			} else {
				contextLines = append(contextLines, "A family member or caregiver is the sender of this Reflection.")
			}
			if explorerInReflection {
				contextLines = append(contextLines, fmt.Sprintf("%s has been confirmed to be in this image.", explorerName))
			} else {
				contextLines = append(contextLines, fmt.Sprintf("%s is the AUDIENCE — they are NOT in this image.", explorerName))
			}
			if peopleContext != "" {
				contextLines = append(contextLines, fmt.Sprintf("The sender identified these people: %s", peopleContext))
			}

			var identityRules string
			if explorerInReflection {
				identityRules = fmt.Sprintf("IDENTITY RULES:\n1. %s IS in this image. You may use their name.\n2. Use provided names for others; otherwise describe by visible traits.\n3. DO NOT guess medical conditions.", explorerName)
			} else {
				identityRules = fmt.Sprintf("CRITICAL IDENTITY RULES:\n1. NEVER identify anyone as %s. They are the viewer.\n2. Use provided names if given; otherwise describe by visible traits.\n3. DO NOT guess medical conditions.", explorerName)
			}

			var companionRules string
			if companionName != "" && companionInReflection {
				companionRules = fmt.Sprintf("Since %s is both sender and visible, use their name naturally.", companionName)
			} else if companionName != "" {
				companionRules = fmt.Sprintf("Work %s's name in so it feels like the Reflection comes from them.", companionName)
			} else {
				companionRules = "You may refer to the sender as a family member or caregiver."
			}

			var contextBlock string
			for _, line := range contextLines {
				contextBlock += "- " + line + "\n"
			}
			promptText = fmt.Sprintf("Analyze this image for a 15-year-old with Angelman Syndrome named %s.\n\nCONTEXT:\n%s\n%s\n\nCONTENT RULES:\n4. short_caption: warm greeting TO %s (max 10 words).\n5. deep_dive: 2-3 sentence story speaking TO %s.\n6. %s\n\nReturn JSON: {\"short_caption\": \"string\", \"deep_dive\": \"string\"}",
				explorerName, contextBlock, identityRules, explorerName, explorerName, companionRules)
			if result.CleanedContext != "" {
				promptText = augmentPromptWithSpokenContext(promptText, result.CleanedContext, result.SuggestedCaption)
			}
		}

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

		if err := parseGeminiJSONText(text, &result); err != nil {
			log.Printf("JSON Parse Error (final): %v", err)
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

	if skipTTS {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			log.Printf("Error encoding JSON response: %v", err)
			http.Error(w, "Failed to encode response", 500)
		}
		return
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

	// Synthesizes speech with one retry; TTS failures here must never be silent —
	// a missing audio URL forces the apps onto the robotic device-TTS fallback.
	synthesizeSpeechWithRetry := func(label, text, voiceName string) []byte {
		speechData, ttsErr := GenerateSpeechWithOptions(text, SpeechOptions{VoiceName: voiceName})
		if ttsErr != nil || len(speechData) == 0 {
			log.Printf("TTS ERROR (%s, attempt 1/2): err=%v, bytes=%d — retrying", label, ttsErr, len(speechData))
			speechData, ttsErr = GenerateSpeechWithOptions(text, SpeechOptions{VoiceName: voiceName})
		}
		if ttsErr != nil || len(speechData) == 0 {
			log.Printf("TTS ERROR (%s, attempt 2/2): err=%v, bytes=%d — returning without audio", label, ttsErr, len(speechData))
			return nil
		}
		return speechData
	}

	// 6. Generate speech using Google Cloud TTS (Journey voice)
	if result.ShortCaption != "" && !skipCaptionTTS {
		log.Printf("TTS: Generating speech for caption: %s", result.ShortCaption)
		speechData := synthesizeSpeechWithRetry("caption", result.ShortCaption, captionVoice)
		if speechData != nil {
			audioKey := fmt.Sprintf("staging/%s/tts/%d.mp3", explorerID, time.Now().UnixNano())

			if err := UploadToS3(ctx, audioKey, speechData, "audio/mpeg"); err == nil {
				presignedRes, _ := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
					Bucket: aws.String("reflections-1200b-storage"),
					Key:    aws.String(audioKey),
				})
				result.AudioURL = presignedRes.URL
				result.AudioS3Key = audioKey
				log.Printf("Generated TTS for caption at: %s", audioKey)
			} else {
				log.Printf("TTS ERROR (caption): S3 upload failed: %v", err)
			}
		}
	} else if skipCaptionTTS {
		log.Printf("TTS: Skipping caption TTS (human voice / skip_caption_tts)")
	}

	// 8. Generate Speech for Deep Dive
	if result.DeepDive != "" {
		log.Printf("TTS: Generating speech for deep dive: %s", result.DeepDive)
		deepDiveSpeechData := synthesizeSpeechWithRetry("deep_dive", result.DeepDive, deepDiveVoice)
		if deepDiveSpeechData != nil {
			deepDiveAudioKey := fmt.Sprintf("staging/%s/tts/deepdive_%d.mp3", explorerID, time.Now().UnixNano())

			if err := UploadToS3(ctx, deepDiveAudioKey, deepDiveSpeechData, "audio/mpeg"); err == nil {
				presignedRes, _ := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
					Bucket: aws.String("reflections-1200b-storage"),
					Key:    aws.String(deepDiveAudioKey),
				})
				result.DeepDiveAudioURL = presignedRes.URL
				result.DeepDiveAudioS3Key = deepDiveAudioKey
				log.Printf("Generated Deep Dive TTS at: %s", deepDiveAudioKey)
			} else {
				log.Printf("TTS ERROR (deep_dive): S3 upload failed: %v", err)
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
