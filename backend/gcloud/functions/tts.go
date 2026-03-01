package functions

import (
	"context"
	"fmt"
	"strings"

	texttospeech "cloud.google.com/go/texttospeech/apiv1"
	"cloud.google.com/go/texttospeech/apiv1/texttospeechpb"
)

const (
	DefaultGoogleTTSLanguageCode = "en-US"
	DefaultGoogleTTSVoiceName    = "en-US-Journey-O"
)

// Limited allowlist keeps behavior predictable and avoids invalid user-supplied voices.
var allowedGoogleTTSVoices = map[string]struct{}{
	"en-US-Journey-F": {},
	"en-US-Journey-D": {},
	"en-US-Journey-O": {},
	"en-US-Studio-O": {},
	"en-US-Neural2-C": {},
	"en-US-Studio-Q": {},
	"en-US-Casual-K": {},
	"en-US-Chirp3-HD-Sulafat": {},
	"en-US-Chirp3-HD-Achernar": {},
	"en-US-Chirp3-HD-Despina": {},
}

// SpeechOptions allows callers to customize synthesis while keeping backward compatibility.
type SpeechOptions struct {
	VoiceName    string
	LanguageCode string
}

// GenerateSpeech calls Google Cloud Text-to-Speech and returns MP3 audio bytes.
func GenerateSpeech(text string) ([]byte, error) {
	ctx := context.Background()

	client, err := texttospeech.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to create Google TTS client: %w", err)
	}
	defer client.Close()

	req := &texttospeechpb.SynthesizeSpeechRequest{
		Input: &texttospeechpb.SynthesisInput{
			InputSource: &texttospeechpb.SynthesisInput_Text{Text: text},
		},
		Voice: &texttospeechpb.VoiceSelectionParams{
			LanguageCode: "en-US",
		Name: DefaultGoogleTTSVoiceName,
		},
		AudioConfig: &texttospeechpb.AudioConfig{
			AudioEncoding: texttospeechpb.AudioEncoding_MP3,
		},
	}

	resp, err := client.SynthesizeSpeech(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("failed to synthesize speech: %w", err)
	}

	return resp.AudioContent, nil
}

func sanitizeGoogleTTSVoice(voiceName string) string {
	normalized := strings.TrimSpace(voiceName)
	if normalized == "" {
		return DefaultGoogleTTSVoiceName
	}
	if _, ok := allowedGoogleTTSVoices[normalized]; ok {
		return normalized
	}
	return DefaultGoogleTTSVoiceName
}

func sanitizeGoogleTTSLanguage(languageCode string) string {
	normalized := strings.TrimSpace(languageCode)
	if normalized == "" {
		return DefaultGoogleTTSLanguageCode
	}
	return normalized
}

// GenerateSpeechWithOptions allows voice/language overrides without breaking existing callers.
func GenerateSpeechWithOptions(text string, opts SpeechOptions) ([]byte, error) {
	ctx := context.Background()

	client, err := texttospeech.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to create Google TTS client: %w", err)
	}
	defer client.Close()

	req := &texttospeechpb.SynthesizeSpeechRequest{
		Input: &texttospeechpb.SynthesisInput{
			InputSource: &texttospeechpb.SynthesisInput_Text{Text: text},
		},
		Voice: &texttospeechpb.VoiceSelectionParams{
			LanguageCode: sanitizeGoogleTTSLanguage(opts.LanguageCode),
			Name:         sanitizeGoogleTTSVoice(opts.VoiceName),
		},
		AudioConfig: &texttospeechpb.AudioConfig{
			AudioEncoding: texttospeechpb.AudioEncoding_MP3,
		},
	}

	resp, err := client.SynthesizeSpeech(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("failed to synthesize speech: %w", err)
	}

	return resp.AudioContent, nil
}
