import * as Updates from 'expo-updates';
import { useEffect } from 'react';

export function useOTAUpdate() {
    useEffect(() => {
        async function check() {
            if (__DEV__) return; // Don't check in dev mode

            try {
                const update = await Updates.checkForUpdateAsync();

                if (update.isAvailable) {
                    // Optional: Show a toast or small UI here saying "Updating..."
                    await Updates.fetchUpdateAsync();

                    // Immediate reload to apply the new code
                    await Updates.reloadAsync();
                }
            } catch (e) {
                // Updates frequently fail on bad networks.
                // Silently fail so the user can still use the old version.
                console.log('OTA Check failed:', e);
            }
        }

        check();
    }, []);
}