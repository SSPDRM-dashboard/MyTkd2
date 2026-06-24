import { initializeApp } from 'firebase/app';
import { getFirestore, onSnapshot, doc, collection, query } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app);

const unsub = onSnapshot(doc(db, 'sync', 'tkd_bout_queue'), (snap) => {
  if (snap.exists()) {
    console.log("Found tkd_bout_queue");
    const data = snap.data().value;
    console.log(`total items: ${data.length}`);
    const byEvent = data.reduce((acc, item) => {
       const eid = item.data?.eventId || 'none';
       acc[eid] = (acc[eid] || 0) + 1;
       return acc;
    }, {});
    console.log(byEvent);
    
  } else {
    console.log("No tkd_bout_queue document");
  }
  
  onSnapshot(query(collection(db, 'tkd_match_history')), snapshot => {
    console.log('History items:', snapshot.size);
    process.exit(0);
  });
});
