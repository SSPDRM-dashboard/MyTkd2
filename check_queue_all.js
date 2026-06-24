const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const queue = data.fields.value.arrayValue.values || [];
      queue.forEach(q => {
          const dataField = q.mapValue.fields.data.mapValue.fields;
          const bout = dataField.bout?.stringValue || dataField.bout?.integerValue || '';
          const ring = dataField.ring?.integerValue || dataField.ring?.stringValue || '';
          
          const boutStr = String(bout).toUpperCase();
          if (boutStr.includes('C17') || boutStr.includes('C18') || boutStr.includes('C19') || boutStr.includes('C20') || boutStr.includes('C21') || boutStr.includes('C22') || boutStr.includes('3017') || boutStr.includes('3018') || boutStr.includes('3019') || boutStr.includes('3020') || boutStr.includes('3021') || boutStr.includes('3022')) {
            console.log(`Bout: ${boutStr}, Ring: ${ring}, EventId: ${dataField.eventId?.stringValue}`);
          }
      });
  } 
}
run().catch(console.error);
