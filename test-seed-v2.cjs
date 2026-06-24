const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_events_v2');
  
  const events = [
    {
      id: 'hyihmup5f',
      name: 'Hana 2026 day 1',
      eventDate: '2026-06-06',
      sheetUrl: 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec',
      winnerSheetUrl: '',
      ringQuantity: 6,
      createdAt: {}
    },
    {
      id: 'dqyof3jl4',
      name: 'Hana 2026 day 2',
      eventDate: '2026-06-07',
      sheetUrl: 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec',
      winnerSheetUrl: '',
      ringQuantity: 6,
      createdAt: {}
    },
    {
      id: '1yec44t3o',
      name: 'TRY',
      eventDate: '2026-06-04',
      sheetUrl: 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec',
      winnerSheetUrl: '',
      ringQuantity: 4,
      createdAt: {}
    },
    {
      id: 'eu7fp235r',
      name: 'Recovered Event (eu7fp235r)',
      eventDate: '2026-06-06',
      sheetUrl: 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec',
      winnerSheetUrl: '',
      ringQuantity: 6,
      createdAt: {}
    }
  ];

  await setDoc(ref, { value: events });
  console.log("Seeded tkd_events_v2!");
  process.exit(0);
}
main();
