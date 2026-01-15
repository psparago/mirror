import * as Application from 'expo-application';

const isDev = Application.applicationId?.includes('.dev');

export const ExplorerIdentity = {
    // Returns 'peter' if running the Dev Client, 'cole' otherwise
    currentExplorerId: isDev ? 'peter' : 'cole',

    collections: {
        reflections: 'reflections',
        responses: 'responses',
    }
};