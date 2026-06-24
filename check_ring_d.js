const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_rings`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const rings = data.fields.value.arrayValue.values || [];
      const ring4 = rings.find(r => r.mapValue.fields.ringNumber.integerValue === '4');
      if (ring4) {
          const current = ring4.mapValue.fields.currentBout?.mapValue?.fields;
          const ondeck = ring4.mapValue.fields.onDeck?.mapValue?.fields;
          const hole = ring4.mapValue.fields.inTheHole?.mapValue?.fields;
          
          console.log("Ring D (4):");
          console.log("Current:", current?.bout?.stringValue || current?.bout?.integerValue, current?.eventId?.stringValue);
          console.log("On Deck:", ondeck?.bout?.stringValue || ondeck?.bout?.integerValue, ondeck?.eventId?.stringValue);
          console.log("In Hole:", hole?.bout?.stringValue || hole?.bout?.integerValue, hole?.eventId?.stringValue);
          console.log("Next Expected Bout:", ring4.mapValue.fields.nextBoutNumber?.integerValue);
      }
      const ring3 = rings.find(r => r.mapValue.fields.ringNumber.integerValue === '3');
      if (ring3) {
          console.log("Ring C (3) Next Expected:", ring3.mapValue.fields.nextBoutNumber?.integerValue);
      }
  } 
}
run().catch(console.error);
