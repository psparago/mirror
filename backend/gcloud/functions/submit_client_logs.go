package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
)

const (
	clientDiagnosticsSource     = "connect-diagnostics"
	maxClientLogBodyBytes       = 512 * 1024
	maxClientLogEntries         = 500
	maxClientLogUserNoteRunes   = 500
	maxClientLogBatchesPerHour  = 10
)

var (
	clientLogAuthOnce sync.Once
	clientLogAuth     *auth.Client
	clientLogAuthErr  error

	clientLogRateMu sync.Mutex
	clientLogRate   = map[string][]time.Time{}

	redactBearerPattern = regexp.MustCompile(`(?i)bearer\s+[a-z0-9._-]+`)
	redactURLQuery      = regexp.MustCompile(`https?://[^\s"']+[?][^\s"']*`)
	redactEmail         = regexp.MustCompile(`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`)
)

type clientDiagnosticEntry struct {
	Ts      string `json:"ts"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type clientDiagnosticApp struct {
	Version         string  `json:"version"`
	BuildNumber     string  `json:"buildNumber"`
	RuntimeVersion  string  `json:"runtimeVersion"`
	OtaLabel        *string `json:"otaLabel"`
	UpdateChannel   *string `json:"updateChannel"`
	Platform        string  `json:"platform"`
	OSVersion       string  `json:"osVersion"`
	DeviceModel     *string `json:"deviceModel"`
}

type clientDiagnosticBatch struct {
	BatchID          string                  `json:"batchId"`
	SentAt           string                  `json:"sentAt"`
	InstallID        string                  `json:"installId"`
	CompanionName    *string                 `json:"companionName"`
	ExplorerName     *string                 `json:"explorerName"`
	RelationshipID   *string                 `json:"relationshipId"`
	App              clientDiagnosticApp     `json:"app"`
	UserNote         *string                 `json:"userNote"`
	Entries          []clientDiagnosticEntry `json:"entries"`
}

func getClientLogAuth(ctx context.Context) (*auth.Client, error) {
	clientLogAuthOnce.Do(func() {
		projectID := os.Getenv("GCP_PROJECT")
		if projectID == "" {
			projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
		}
		if projectID == "" {
			projectID = "reflections-1200b"
		}
		conf := &firebase.Config{ProjectID: projectID}
		app, err := firebase.NewApp(ctx, conf)
		if err != nil {
			clientLogAuthErr = fmt.Errorf("firebase app: %w", err)
			return
		}
		clientLogAuth, clientLogAuthErr = app.Auth(ctx)
	})
	return clientLogAuth, clientLogAuthErr
}

func allowClientLogBatch(uid string) bool {
	now := time.Now()
	cutoff := now.Add(-1 * time.Hour)

	clientLogRateMu.Lock()
	defer clientLogRateMu.Unlock()

	times := clientLogRate[uid]
	filtered := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) >= maxClientLogBatchesPerHour {
		clientLogRate[uid] = filtered
		return false
	}
	filtered = append(filtered, now)
	clientLogRate[uid] = filtered
	return true
}

func redactClientLogMessage(message string) string {
	message = redactBearerPattern.ReplaceAllString(message, "[REDACTED_BEARER]")
	message = redactURLQuery.ReplaceAllString(message, "[REDACTED_URL]")
	message = redactEmail.ReplaceAllString(message, "[REDACTED_EMAIL]")
	if len(message) > 2048 {
		message = message[:2048] + "…"
	}
	return message
}

func writeClientDiagnosticLog(payload map[string]any) {
	data, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stdout, `{"severity":"ERROR","source":"%s","message":"marshal failed"}`, clientDiagnosticsSource)
		return
	}
	fmt.Fprintf(os.Stdout, "%s\n", data)
}

// SubmitClientLogs accepts opt-in diagnostic batches from Reflections Connect.
func SubmitClientLogs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return
	}
	idToken := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if idToken == "" {
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return
	}

	ctx := r.Context()
	authClient, err := getClientLogAuth(ctx)
	if err != nil {
		http.Error(w, "auth init failed", http.StatusInternalServerError)
		return
	}
	decoded, err := authClient.VerifyIDToken(ctx, idToken)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	if !allowClientLogBatch(decoded.UID) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxClientLogBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	var batch clientDiagnosticBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if batch.BatchID == "" || batch.InstallID == "" {
		http.Error(w, "batchId and installId required", http.StatusBadRequest)
		return
	}
	if len(batch.Entries) == 0 {
		http.Error(w, "entries required", http.StatusBadRequest)
		return
	}
	if len(batch.Entries) > maxClientLogEntries {
		http.Error(w, "too many entries", http.StatusBadRequest)
		return
	}
	if batch.UserNote != nil && len([]rune(*batch.UserNote)) > maxClientLogUserNoteRunes {
		http.Error(w, "userNote too long", http.StatusBadRequest)
		return
	}

	var userNote string
	if batch.UserNote != nil {
		userNote = redactClientLogMessage(strings.TrimSpace(*batch.UserNote))
	}

	for _, entry := range batch.Entries {
		level := entry.Level
		if level == "" {
			level = "log"
		}
		writeClientDiagnosticLog(map[string]any{
			"severity":        strings.ToUpper(level),
			"source":          clientDiagnosticsSource,
			"batchId":         batch.BatchID,
			"installId":       batch.InstallID,
			"firebaseUid":     decoded.UID,
			"companionName":   batch.CompanionName,
			"explorerName":    batch.ExplorerName,
			"relationshipId":  batch.RelationshipID,
			"appVersion":      batch.App.Version,
			"buildNumber":     batch.App.BuildNumber,
			"runtimeVersion":  batch.App.RuntimeVersion,
			"platform":        batch.App.Platform,
			"osVersion":       batch.App.OSVersion,
			"deviceModel":     batch.App.DeviceModel,
			"otaLabel":        batch.App.OtaLabel,
			"updateChannel":   batch.App.UpdateChannel,
			"userNote":        userNote,
			"entryTs":         entry.Ts,
			"entryLevel":      level,
			"message":         redactClientLogMessage(entry.Message),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"batchId":  batch.BatchID,
		"accepted": len(batch.Entries),
	})
}
