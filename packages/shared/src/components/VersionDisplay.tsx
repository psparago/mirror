import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export default function VersionDisplay() {
    // 1. The "Hard" Version (What the App Store sees)
    const nativeVersion = Application.nativeApplicationVersion; // e.g., "1.0.1"
    const buildNumber = Application.nativeBuildVersion;         // e.g., "2"

    // 2. The "Soft" Version (What app.json says)
    const configVersion = Constants.expoConfig?.version;        // e.g., "1.0.1-patch"

    // 3. The "Ghost" Version (The OTA Update ID)
    // If this is running from a specific OTA update, this ID will be a long UUID.
    // If it's running the embedded code, it might be null or different.
    const updateId = Updates.updateId ? Updates.updateId.slice(0, 8) : 'Embedded';
    const channel = Updates.channel || 'dev';

    return (
        <View style={styles.container}>
            <Text style={styles.text}>
                v{nativeVersion} ({buildNumber})
            </Text>
            <Text style={styles.subtext}>
                JS: {configVersion} | Ch: {channel}
            </Text>
            <Text style={styles.idText}>
                Update ID: {updateId}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 10,
        alignItems: 'center',
        opacity: 0.6,
    },
    text: {
        color: '#888', // Use a visible color for your background
        fontSize: 12,
        fontWeight: 'bold',
    },
    subtext: {
        color: '#888',
        fontSize: 10,
    },
    idText: {
        color: '#888',
        fontSize: 8,
        fontFamily: 'Courier', // Monospace for the ID
    }
});