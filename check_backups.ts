import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const bDoc = await getDoc(doc(db, 'sync', 'tkd_backup_data_v3'));
  console.log("=== tkd_backup_data_v3 ===");
  if (bDoc.exists()) {
    const data = bDoc.data();
    const eventKeys = Object.keys(data.value || {});
    console.log(`Found backups for events:`, eventKeys);
    
    eventKeys.forEach(eventId => {
      const bObj = data.value[eventId];
      console.log(`\nEvent [${eventId}]:`);
      if (bObj.mappings) {
        console.log(`  - Mappings count: ${bObj.mappings.length}`);
      }
      if (bObj.matches) {
        console.log(`  - Matches count: ${bObj.matches.length}`);
        
        // Find our target bouts
        const targets = bObj.matches.filter((m: any) => {
          const ring = String(m.ring || m.ringNumber);
          const bout = String(m.bout || m.boutNumber);
          return (
            (ring === "1" && ["1002", "2"].includes(bout)) ||
            (ring === "2" && ["2001", "2002", "1", "2"].includes(bout)) ||
            (ring === "3" && ["3001", "3002", "1", "2"].includes(bout))
          );
        });

        console.log(`  - Targets in backup: ${targets.length}`);
        targets.forEach((t: any) => {
          console.log(`    - Ring ${t.ring} Bout ${t.bout}: ${t.blue_name} vs ${t.red_name}`);
        });
      }
    });
  } else {
    console.log("Not found.");
  }

  process.exit(0);
}

run();
