const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const queue = data.fields.value.arrayValue.values || [];
      const currentEventId = '9x893h9gl';
      queue.forEach(q => {
          const dataField = q.mapValue.fields.data.mapValue.fields;
          const bout = dataField.bout?.stringValue || dataField.bout?.integerValue || '';
          const ring = dataField.ring?.integerValue || dataField.ring?.stringValue || '';
          const eventId = dataField.eventId?.stringValue || '';
          
          if (eventId !== currentEventId) return;
          console.log(`Bout: ${bout}, Ring: ${ring}`);
      });
  } 
}
run().catch(console.error);
