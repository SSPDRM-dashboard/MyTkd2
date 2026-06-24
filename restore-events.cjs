const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);

const dbDefault = getFirestore(app);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const docRef = doc(dbDefault, 'sync', 'tkd_events');
  const snap = await getDoc(docRef);
  
  if (snap.exists()) {
    const data = snap.data();
    console.log("Copying tkd_events from default to named DB:");
    console.log(JSON.stringify(data).slice(0, 500));
    
    await setDoc(doc(dbNamed, 'sync', 'tkd_events'), data);
    console.log("Copied successfully.");
  } else {
    console.log("No tkd_events in default DB.");
  }

  // Also copy tkd_current_event just in case
  const ceRef = doc(dbDefault, 'sync', 'tkd_current_event');
  const ceSnap = await getDoc(ceRef);
  if (ceSnap.exists()) {
    await setDoc(doc(dbNamed, 'sync', 'tkd_current_event'), ceSnap.data());
    console.log("Copied tkd_current_event successfully.");
  }

  process.exit(0);
}
main();
