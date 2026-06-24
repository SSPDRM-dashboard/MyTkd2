const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const syncSnap = await getDocs(collection(db, 'sync'));
  console.log("Documents in 'sync':");
  syncSnap.forEach(doc => {
    console.log(" -", doc.id, JSON.stringify(doc.data()).slice(0, 500));
  });
  
  const matchSnap = await getDocs(collection(db, 'matchHistory'));
  console.log("matchHistory count:", matchSnap.docs.length);

  process.exit(0);
}
main();
