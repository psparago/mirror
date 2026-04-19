import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { DEFAULT_AUTOPLAY, DEFAULT_INSTANT_VIDEO_PLAYBACK, DEFAULT_TAKE_SELFIE } from '@/constants/Defaults';
import { ExplorerConfig, VersionDisplay } from '@projectmirror/shared';
import { auth, db, doc, setDoc } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useExplorerSelf } from '../context/ExplorerSelfContext';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;
    const router = useRouter();
    const { explorerId, explorerData } = useExplorerSelf();

    const [autoplay, setAutoplay] = useState(DEFAULT_AUTOPLAY);
    // Instant video playback setting
    const [instantVideoPlayback, setInstantVideoPlayback] = useState(DEFAULT_INSTANT_VIDEO_PLAYBACK);
    const [takeSelfie, setTakeSelfie] = useState(DEFAULT_TAKE_SELFIE);
    const [lastOtaLabel, setLastOtaLabel] = useState<string | null>(null);

    console.log('auth.currentUser.uid', auth.currentUser?.uid);

    useEffect(() => {
        AsyncStorage.getItem('instantVideoPlayback').then(value => {
            if (value !== null) {
                setInstantVideoPlayback(value === 'true');
            }
        }).catch(err => console.warn('Failed to load setting:', err));
        AsyncStorage.getItem('takeSelfie').then(value => {
            if (value !== null) {
                setTakeSelfie(value === 'true');
            }
        }).catch(err => console.warn('Failed to load take selfie setting:', err));
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

    const toggleTakeSelfie = async (value: boolean) => {
        setTakeSelfie(value);
        try {
            await AsyncStorage.setItem('takeSelfie', value.toString());
        } catch (err) {
            console.warn('Failed to save take selfie setting:', err);
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
                                    Open the newest Reflection automatically when Explorer starts
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
                                    Start videos immediately without reading caption
                                </Text>
                            </View>
                            <Switch
                                value={instantVideoPlayback}
                                onValueChange={toggleInstantVideoPlayback}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={instantVideoPlayback ? '#fff' : '#f4f3f4'}
                            />
                        </View>
                        <View style={[styles.settingRow, { marginTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', paddingTop: 16 }]}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Take Selfie</Text>
                                <Text style={styles.settingDescription}>
                                    After a reflection, capture your selfie response automatically (turn off to browse without sending your selfie)
                                </Text>
                            </View>
                            <Switch
                                value={takeSelfie}
                                onValueChange={toggleTakeSelfie}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={takeSelfie ? '#fff' : '#f4f3f4'}
                            />
                        </View>
                    </View>
                </View>

                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                >
                    <Text style={styles.backButtonText}>Exit System Info</Text>
                </TouchableOpacity>

                <View style={styles.footer}>
                    <Text style={styles.footerText}>Reflection Explorer</Text>
                    <Text style={styles.footerSubtext}>by Angelware</Text>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0f2027', // Match LG dark theme
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

