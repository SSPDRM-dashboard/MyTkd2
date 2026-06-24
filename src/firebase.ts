import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDocFromServer, disableNetwork, setLogLevel } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

setLogLevel('silent');

// Initialize Firebase SDK
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const disableFirestoreNetwork = async () => {
  try {
    setLogLevel('silent');
    await disableNetwork(db);
    console.log("Firestore network disabled due to quota exhaustion.");
  } catch (err) {
    console.error("Failed to disable Firestore network:", err);
  }
};

// Test Firestore connection on boot
async function testFirestoreConnection() {
  if (localStorage.getItem('tkd_disable_firebase') === 'true') {
    disableFirestoreNetwork();
    return;
  }
  try {
    await getDocFromServer(doc(db, 'sync', 'connection_test'));
    console.log("Firestore connection verified.");
  } catch (error: any) {
    if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
      console.warn("Firestore Quota Exceeded on boot.");
      disableFirestoreNetwork();
      window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));
    } else if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("CRITICAL: Firestore is offline. This usually means the configuration in firebase-applet-config.json is incorrect or the database is not ready.");
    }
  }
}
testFirestoreConnection();
