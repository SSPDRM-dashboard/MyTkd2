const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const queue = data.fields.value.arrayValue.values || [];
      const currentEventId = '9x893h9gl';
      
      const existingBouts = new Set(
          queue.filter(q => {
              const dataField = q.mapValue.fields.data.mapValue.fields;
              return dataField.eventId?.stringValue === currentEventId;
          }).map(q => {
              const dataField = q.mapValue.fields.data.mapValue.fields;
              return String(dataField.bout?.stringValue || dataField.bout?.integerValue).toUpperCase();
          })
      );
      
      let updated = 0;
      
      const newQueue = queue.map(q => {
          const map = q.mapValue.fields;
          const dataField = map.data.mapValue.fields;
          
          if (dataField.eventId?.stringValue === 'hyihmup5f') {
              const bout = String(dataField.bout?.stringValue || dataField.bout?.integerValue).toUpperCase();
              if (!existingBouts.has(bout)) {
                  updated++;
                  dataField.eventId.stringValue = currentEventId;
              }
          }
          return q;
      }).filter(q => {
          const dataField = q.mapValue.fields.data.mapValue.fields;
          return dataField.eventId?.stringValue === currentEventId;
      });
      
      console.log(`Migrated ${updated} orphaned bouts. Final queue length: ${newQueue.length}`);
      
      const updateUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue?updateMask.fieldPaths=value`;
      const updatePayload = {
          fields: {
              value: {
                  arrayValue: {
                      values: newQueue
                  }
              }
          }
      };
      
      const patchRes = await fetch(updateUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload)
      });
      
      const patchData = await patchRes.json();
      if (patchData.error) {
          console.error("Failed to patch:", patchData.error);
      } else {
          console.log("Successfully fixed queue!");
      }
  } 
}
run().catch(console.error);
