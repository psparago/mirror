import { ExplorerConfig } from '@projectmirror/shared/explorer/ExplorerConfig';
import { auth, db } from '@projectmirror/shared/firebase';
import { usePushToken } from '@projectmirror/shared/hooks/usePushToken';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import React, { createContext, useContext, useEffect, useState } from 'react';

interface ExplorerSelfContextType {
    explorerId: string | null;  // "PETER-08271957"
    explorerData: any | null;   // The full profile (name, preferences)
    loading: boolean;
}

const ExplorerSelfContext = createContext<ExplorerSelfContextType>({
    explorerId: null,
    explorerData: null,
    loading: true,
});

export function ExplorerSelfProvider({ children }: { children: React.ReactNode }) {
    const [explorerId, setExplorerId] = useState<string | null>(null);
    const [explorerData, setExplorerData] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);

    // PUSH TOKEN
    const { token: pushToken, error } = usePushToken();

    useEffect(() => {
        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        // Query: Find the explorer record linked to THIS anonymous device
        const q = query(
            collection(db, ExplorerConfig.collections.explorers),
            where('authorizedDevices', 'array-contains', user.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            if (!snapshot.empty) {
                // Found him!
                const d = snapshot.docs[0];
                const currentData = d.data();

                setExplorerId(d.id);
                setExplorerData(currentData);

                // Only write to DB if the token is NEW or DIFFERENT
                if (pushToken && currentData.pushToken !== pushToken) {
                    console.log(`[ExplorerSelf] New Push Token detected. Saving to ${d.id}...`);

                    const explorerRef = doc(db, ExplorerConfig.collections.explorers, d.id);

                    // Use .catch() to handle the promise without async/await syntax in the callback
                    updateDoc(explorerRef, {
                        pushToken: pushToken,
                        lastDeviceSync: new Date() // Optional: helpful for debugging
                    }).catch((e) => {
                        console.warn("Failed to save Explorer push token:", e);
                    });
                    
                } console.log(`✅ [ExplorerSelf] Identified as: ${d.id}`);
            } else {
                console.warn(`⚠️ [ExplorerSelf] Device (UID: ${user.uid}) is not linked to an Explorer record.`);
                setExplorerId(null);
                setExplorerData(null);
            }
            setLoading(false);
        }, (err) => {
            console.error("Error identifying explorer:", err);
            setLoading(false);
        });

        return () => unsubscribe();
    }, [pushToken]);

    return (
        <ExplorerSelfContext.Provider value={{ explorerId, explorerData, loading }}>
            {children}
        </ExplorerSelfContext.Provider>
    );
}

export const useExplorerSelf = () => useContext(ExplorerSelfContext);