package functions

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxSynthesizeSpeechChars = 180

type synthesizeSpeechRequest struct {
	Text  string `json:"text"`
	Voice string `json:"voice"`
}

type synthesizeSpeechResponse struct {
	AudioBase64 string `json:"audioBase64"`
}

// SynthesizeSpeech generates ephemeral Google TTS audio and returns MP3 bytes as base64.
// No S3 persistence — clients play and discard.
func SynthesizeSpeech(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	var req synthesizeSpeechRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	text := strings.TrimSpace(req.Text)
	if text == "" || utf8.RuneCountInString(text) > maxSynthesizeSpeechChars {
		http.Error(w, "invalid text", http.StatusBadRequest)
		return
	}

	voice := sanitizeGoogleTTSVoice(req.Voice)
	speechData, err := GenerateSpeechWithOptions(text, SpeechOptions{
		VoiceName: voice,
	})
	if err != nil || len(speechData) == 0 {
		http.Error(w, "synthesis failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(synthesizeSpeechResponse{
		AudioBase64: base64.StdEncoding.EncodeToString(speechData),
	})
}
