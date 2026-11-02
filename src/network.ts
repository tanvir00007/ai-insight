import Constants from 'expo-constants';
import { Platform } from 'react-native';

const AI_GATEWAY_PORT = 8787;
const CONFIGURED_GATEWAY_HOST = process.env.EXPO_PUBLIC_AI_GATEWAY_HOST;

type ExpoConstantsShape = {
  expoConfig?: { hostUri?: string };
  manifest?: { debuggerHost?: string };
  manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
};

function hostOnly(value?: string | null) {
  if (!value) return null;
  return value.split(':')[0] || null;
}

export function getAiGatewayUrls() {
  const constants = Constants as ExpoConstantsShape;
  const detectedHost =
    hostOnly(constants.expoConfig?.hostUri) ??
    hostOnly(constants.manifest2?.extra?.expoClient?.hostUri) ??
    hostOnly(constants.manifest?.debuggerHost);

  const urls = [
    detectedHost ? `http://${detectedHost}:${AI_GATEWAY_PORT}` : null,
    CONFIGURED_GATEWAY_HOST ? `http://${CONFIGURED_GATEWAY_HOST}:${AI_GATEWAY_PORT}` : null,
    Platform.OS === 'web' ? `http://localhost:${AI_GATEWAY_PORT}` : null,
  ].filter((url): url is string => Boolean(url));

  return Array.from(new Set(urls));
}
