import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { DEFAULT_AUTOPLAY, DEFAULT_INSTANT_VIDEO_PLAYBACK } from '@/constants/Defaults';
import { ExplorerConfig, VersionDisplay } from '@projectmirror/shared';
import { auth, db, doc, setDoc } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useExplorerSelf } from '../context/ExplorerSelfContext';
import {
    getDiagnosticsBufferStats,
    isDiagnosticsEnabled,
    sendDiagnosticBatch,
    setDiagnosticsEnabled,
} from '../utils/diagnosticsLog';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;
    const router = useRouter();
    const { explorerId, explorerData } = useExplorerSelf();

    const [autoplay, setAutoplay] = useState(DEFAULT_AUTOPLAY);
    // Instant video playback setting
    const [instantVideoPlayback, setInstantVideoPlayback] = useState(DEFAULT_INSTANT_VIDEO_PLAYBACK);
    const [lastOtaLabel, setLastOtaLabel] = useState<string | null>(null);

    const [diagnosticsEnabled, setDiagnosticsEnabledState] = useState(false);
    const [diagnosticsEntryCount, setDiagnosticsEntryCount] = useState(0);
    const [diagnosticsApproxBytes, setDiagnosticsApproxBytes] = useState(0);
    const [diagnosticsNote, setDiagnosticsNote] = useState('');
    const [diagnosticsSending, setDiagnosticsSending] = useState(false);

    console.log('auth.currentUser.uid', auth.currentUser?.uid);

    const refreshDiagnosticsStats = useCallback(async () => {
        const stats = await getDiagnosticsBufferStats();
        setDiagnosticsEntryCount(stats.entryCount);
        setDiagnosticsApproxBytes(stats.approxBytes);
    }, []);

    useEffect(() => {
        void (async () => {
            const enabled = await isDiagnosticsEnabled();
            setDiagnosticsEnabledState(enabled);
            await refreshDiagnosticsStats();
        })();
    }, [refreshDiagnosticsStats]);

    const handleDiagnosticsToggle = useCallback(
        async (next: boolean) => {
            await setDiagnosticsEnabled(next);
            setDiagnosticsEnabledState(next);
            await refreshDiagnosticsStats();
        },
        [refreshDiagnosticsStats],
    );

    const handleSendDiagnostics = useCallback(async () => {
        setDiagnosticsSending(true);
        try {
            const explorerName =
                explorerData?.displayName || explorerData?.display_name || explorerData?.name || explorerId || null;
            const result = await sendDiagnosticBatch({
                identity: {
                    explorerName,
                    explorerId: explorerId ?? null,
                },
                userNote: diagnosticsNote,
            });
            setDiagnosticsNote('');
            await refreshDiagnosticsStats();
            Alert.alert(
                'Diagnostic logs sent',
                `Batch ID:\n${result.batchId}\n\n${result.accepted} events uploaded. Share the batch ID if we ask for it.`,
            );
        } catch (error) {
            Alert.alert(
                'Could not send logs',
                error instanceof Error ? error.message : 'Please try again.',
            );
        } finally {
            setDiagnosticsSending(false);
        }
    }, [diagnosticsNote, explorerData, explorerId, refreshDiagnosticsStats]);

    useEffect(() => {
        AsyncStorage.getItem('instantVideoPlayback').then(value => {
            if (value !== null) {
                setInstantVideoPlayback(value === 'true');
            }
        }).catch(err => console.warn('Failed to load setting:', err));
    }, []);

    useEffect(() => {
        const firestoreAutoplay = explorerData?.settings?.autoplay;
        setAutoplay(typeof firestoreAutoplay === 'boolean' ? firestoreAutoplay : DEFAULT_AUTOPLAY);
    }, [explorerData?.settings?.autoplay]);

    useEffect(() => {
        AsyncStorage.getItem('last_ota_label').then(setLastOtaLabel).catch(() => {});
    }, []);

    const toggleAutoplay = async (value: boolean) => {
        setAutoplay(value);
        try {
            if (!explorerId) {
                throw new Error('Missing Explorer ID');
            }
            await setDoc(
                doc(db, ExplorerConfig.collections.explorers, explorerId),
                {
                    settings: {
                        ...(explorerData?.settings ?? {}),
                        autoplay: value,
                    },
                },
                { merge: true }
            );
        } catch (err) {
            console.warn('Failed to save autoplay setting to Firestore:', err);
            setAutoplay(typeof explorerData?.settings?.autoplay === 'boolean' ? explorerData.settings.autoplay : DEFAULT_AUTOPLAY);
        }
    };

    const toggleInstantVideoPlayback = async (value: boolean) => {
        setInstantVideoPlayback(value);
        try {
            await AsyncStorage.setItem('instantVideoPlayback', value.toString());
        } catch (err) {
            console.warn('Failed to save setting:', err);
        }
    };

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    title: 'System Information',
                    headerShown: true,
                    headerBackTitle: 'Back',
                    headerStyle: {
                        backgroundColor: '#0f2027',
                    },
                    headerTintColor: '#fff',
                    headerTitleStyle: {
                        fontWeight: 'bold',
                    },
                }}
            />

            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Device & Build</Text>
                    <View style={styles.card}>
                        <VersionDisplay />
                        <View style={[styles.settingRow, { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', paddingTop: 16 }]}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Device ID</Text>
                                <Text style={[styles.settingDescription, { fontFamily: 'monospace', fontSize: 11 }]}>
                                    {auth.currentUser?.uid || 'Not Connected'}
                                </Text>
                            </View>
                        </View>
                        {lastOtaLabel != null ? (
                            <View style={[styles.settingRow, { marginTop: 12 }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={styles.settingLabel}>Last OTA</Text>
                                    <Text style={[styles.settingDescription, { fontFamily: 'monospace', fontSize: 11 }]}>
                                        {lastOtaLabel}
                                    </Text>
                                </View>
                            </View>
                        ) : null}
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Preferences</Text>
                    <View style={styles.card}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Autoplay on Open</Text>
                                <Text style={styles.settingDescription}>
                                    Open the newest Reflection automatically when Reflections Explorer starts
                                </Text>
                            </View>
                            <Switch
                                value={autoplay}
                                onValueChange={toggleAutoplay}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={autoplay ? '#fff' : '#f4f3f4'}
                            />
                        </View>
                        <View style={[styles.settingRow, { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', paddingTop: 16 }]}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Instant Video Playback</Text>
                                <Text style={styles.settingDescription}>
                                    Skip the spoken intro and start videos right away
                                </Text>
                            </View>
                            <Switch
                                value={instantVideoPlayback}
                                onValueChange={toggleInstantVideoPlayback}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={instantVideoPlayback ? '#fff' : '#f4f3f4'}
                            />
                        </View>
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Diagnostic Logs</Text>
                    <View style={styles.card}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Record diagnostic logs</Text>
                                <Text style={styles.settingDescription}>
                                    Captures technical app events to help fix bugs. Does not include Reflection
                                    content or media. Turn on, reproduce the issue, then send below.
                                </Text>
                            </View>
                            <Switch
                                value={diagnosticsEnabled}
                                onValueChange={(val) => void handleDiagnosticsToggle(val)}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={diagnosticsEnabled ? '#fff' : '#f4f3f4'}
                            />
                        </View>

                        <Text
                            style={[
                                styles.settingDescription,
                                { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', paddingTop: 16 },
                            ]}
                        >
                            Buffered: {diagnosticsEntryCount} events (~{Math.max(1, Math.round(diagnosticsApproxBytes / 1024))} KB)
                        </Text>

                        <TextInput
                            style={styles.diagnosticsNoteInput}
                            placeholder="Optional note (e.g. caption plays twice)"
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={diagnosticsNote}
                            onChangeText={setDiagnosticsNote}
                            maxLength={500}
                            multiline
                            editable={!diagnosticsSending}
                        />

                        <TouchableOpacity
                            style={[
                                styles.sendButton,
                                (diagnosticsSending || diagnosticsEntryCount === 0) && styles.sendButtonDisabled,
                            ]}
                            onPress={() => void handleSendDiagnostics()}
                            disabled={diagnosticsSending || diagnosticsEntryCount === 0}
                            activeOpacity={0.8}
                        >
                            {diagnosticsSending ? (
                                <ActivityIndicator color="#fff" />
                            ) : (
                                <Text style={styles.sendButtonText}>Send diagnostic logs</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>

                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                >
                    <Text style={styles.backButtonText}>Exit System Info</Text>
                </TouchableOpacity>

                <View style={styles.footer}>
                    <Text style={styles.footerText}>Reflections Explorer</Text>
                    <Text style={styles.footerSubtext}>by Angelware</Text>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0f2027',
    },
    scrollContent: {
        padding: 32,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
    },
    section: {
        marginBottom: 32,
        width: '100%',
        maxWidth: 500,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 16,
        marginLeft: 4,
        textTransform: 'uppercase',
        color: '#fff',
        textAlign: 'center',
    },
    card: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: 24,
        padding: 32,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
    },
    settingRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    settingInfo: {
        flex: 1,
        marginRight: 16,
    },
    settingLabel: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
    settingDescription: {
        color: 'rgba(255, 255, 255, 0.6)',
        fontSize: 13,
        marginTop: 4,
    },
    diagnosticsNoteInput: {
        marginTop: 16,
        minHeight: 64,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
        backgroundColor: 'rgba(0,0,0,0.2)',
        color: '#fff',
        padding: 12,
        fontSize: 14,
        textAlignVertical: 'top',
    },
    sendButton: {
        marginTop: 16,
        backgroundColor: '#4FC3F7',
        paddingVertical: 14,
        borderRadius: 30,
        alignItems: 'center',
    },
    sendButtonDisabled: {
        opacity: 0.4,
    },
    sendButtonText: {
        color: '#0f2027',
        fontSize: 16,
        fontWeight: 'bold',
    },
    backButton: {
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        paddingVertical: 16,
        paddingHorizontal: 32,
        borderRadius: 30,
        marginTop: 20,
    },
    backButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    footer: {
        marginTop: 60,
        alignItems: 'center',
        opacity: 0.5,
    },
    footerText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#fff',
    },
    footerSubtext: {
        fontSize: 12,
        color: '#ccc',
        marginTop: 4,
    },
});

