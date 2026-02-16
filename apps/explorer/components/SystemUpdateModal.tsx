import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

export function SystemUpdateModal() {
  const { isUpdateAvailable, isDownloading, manifest, downloadAndReload } = useOTAUpdate();

  if (!isUpdateAvailable) return null;

  // Try to parse a readable date from the manifest
  const updateDate = manifest?.createdAt 
    ? new Date(manifest.createdAt).toLocaleDateString() + ' ' + new Date(manifest.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Just now';

  return (
    <Modal
      transparent
      animationType="fade"
      visible={true}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Update Available</Text>
            {/* Blinking dot to show it's live */}
            <View style={styles.dot} />
          </View>

          <Text style={styles.description}>
            A new version of Reflections Explorer is ready.
          </Text>
          
          <View style={styles.metaContainer}>
            <Text style={styles.metaLabel}>Released:</Text>
            <Text style={styles.metaValue}>{updateDate}</Text>
          </View>

          <TouchableOpacity 
            style={[styles.button, isDownloading && styles.buttonDisabled]} 
            onPress={downloadAndReload}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <View style={styles.row}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.buttonText}>Downloading...</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Update & Restart</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#1E1E1E', // Dark mode by default
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginRight: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#00C853', // Success Green
  },
  description: {
    fontSize: 16,
    color: '#ccc',
    marginBottom: 20,
    lineHeight: 22,
  },
  metaContainer: {
    flexDirection: 'row',
    backgroundColor: '#2C2C2C',
    padding: 12,
    borderRadius: 8,
    marginBottom: 24,
  },
  metaLabel: {
    color: '#888',
    marginRight: 8,
    fontSize: 14,
  },
  metaValue: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  button: {
    backgroundColor: '#fff',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  }
});