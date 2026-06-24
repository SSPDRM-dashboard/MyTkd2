const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_events');
  const snap = await getDoc(ref);
  const data = snap.data();
  if (!data) return;

  const events = data.value || [];
  if (!events.find(e => e.id === 'eu7fp235r')) {
    events.push({
      id: 'eu7fp235r',
      name: 'Recovered Event (eu7fp235r)',
      eventDate: '2026-06-06',
      sheetUrl: 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec',
      winnerSheetUrl: '',
      ringQuantity: 6,
      createdAt: {}
    });
    await setDoc(ref, { value: events });
    console.log("Injected missing event!", events);
  } else {
    console.log("Event already exists!");
  }
  process.exit(0);
}
main();
