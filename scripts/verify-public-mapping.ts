import {writeFile} from 'node:fs/promises';
import {parseMmCif,STRUCTURE_CATEGORIES} from '../src/rcsb/mmcif';
import {buildStructure} from '../src/mol/structure';
import {fetchResidueValidation,residueMetrics} from '../src/rcsb/residueValidation';
import {fetchAnnotations} from '../src/rcsb/annotations';
import {mappedResidueMatches} from '../src/rcsb/residueMapping';
import {evaluateSelection,parseSelection} from '../src/mol/selection';
const s=buildStructure(parseMmCif(await fetch('https://files.rcsb.org/download/1IGT.cif').then(r=>r.text()),STRUCTURE_CATEGORIES),'1IGT','');
const [v,annotations]=await Promise.all([fetchResidueValidation('1IGT'),fetchAnnotations('1IGT')]);
const inserted=Array.from({length:s.residueCount},(_,r)=>r).filter(r=>s.resInsCode[r]);
const records=inserted.map(r=>({chain:s.chainAuthId[s.resChain[r]],author:s.resSeq[r],insertion:s.resInsCode[r],labelChain:s.chainLabelId[s.resChain[r]],labelSeq:s.resLabelSeq[r],metrics:residueMetrics(v,s,r)}));
let checked=0;
for(const annotation of annotations){const mask=evaluateSelection(parseSelection(annotation.selection),s);for(let r=0;r<s.residueCount;r++){if(Boolean(mask[s.resAtomStart[r]])!==annotation.residues.some(p=>mappedResidueMatches(s,r,p)))throw new Error('Annotation mask mismatch');}checked++;}
if(!records.length||records.some(r=>!r.metrics))throw new Error('Inserted polymer validation missing');
await writeFile('docs/public-mapping-check.json',JSON.stringify({entry:'1IGT',checkedAt:new Date().toISOString(),coordinateSource:'https://files.rcsb.org/download/1IGT.cif',evidenceSource:'https://data.rcsb.org/graphql',annotationSelectionsChecked:checked,insertedResidues:records},null,2));
console.log(`${records.length} inserted residues retain validation; ${checked} annotation selections verified.`);
