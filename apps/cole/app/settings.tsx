import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay } from '@projectmirror/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;
    const router = useRouter();

    // Infinite scroll setting
    const [enableInfiniteScroll, setEnableInfiniteScroll] = useState(true);
    // Instant video playback setting
    const [instantVideoPlayback, setInstantVideoPlayback] = useState(true);

    useEffect(() => {
        AsyncStorage.getItem('enableInfiniteScroll').then(value => {
            if (value !== null) {
                setEnableInfiniteScroll(value === 'true');
            }
        }).catch(err => console.warn('Failed to load setting:', err));

        AsyncStorage.getItem('instantVideoPlayback').then(value => {
            if (value !== null) {
                setInstantVideoPlayback(value === 'true');
            }
        }).catch(err => console.warn('Failed to load setting:', err));
    }, []);

    const toggleInfiniteScroll = async (value: boolean) => {
        setEnableInfiniteScroll(value);
        try {
            await AsyncStorage.setItem('enableInfiniteScroll', value.toString());
            console.log('✅ Infinite scroll setting saved:', value);
        } catch (err) {
            console.warn('Failed to save setting:', err);
        }
    };

    const toggleInstantVideoPlayback = async (value: boolean) => {
        setInstantVideoPlayback(value);
        try {
            await AsyncStorage.setItem('instantVideoPlayback', value.toString());
            console.log('✅ Instant video playback setting saved:', value);
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
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Preferences</Text>
                    <View style={styles.card}>
                        <View style={styles.settingRow}>
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

                        <View style={[styles.settingRow, { marginTop: 20 }]}>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingLabel}>Infinite Scroll</Text>
                                <Text style={styles.settingDescription}>
                                    Loop reflections when reaching the end
                                </Text>
                            </View>
                            <Switch
                                value={enableInfiniteScroll}
                                onValueChange={toggleInfiniteScroll}
                                trackColor={{ false: '#767577', true: '#4FC3F7' }}
                                thumbColor={enableInfiniteScroll ? '#fff' : '#f4f3f4'}
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
                    <Text style={styles.footerText}>Looking Glass</Text>
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

