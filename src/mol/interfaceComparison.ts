import type { ChainInterface } from './interfaces';
import { alignSequences } from './align';
import { MolKind, resNameOf, type Structure } from './structure';
import { ONE_LETTER } from './elements';

function chainAt(s: Structure, residues: number[]) {
  const chains = new Set(residues.map((r) => s.resChain[r]));
  if (chains.size !== 1)
    throw new Error(
      'Choose an interface side belonging to one chain and model. Load a single NMR model if needed.',
    );
  const chain = [...chains][0];
  const members: number[] = [];
  for (let r = s.chainResStart[chain]; r < s.chainResStart[chain + 1]; r++)
    if (
      s.resAnchor[r] >= 0 &&
      (s.resKind[r] === MolKind.Protein || s.resKind[r] === MolKind.Nucleic)
    )
      members.push(r);
  if (members.length < 3)
    throw new Error(
      'Interface correspondence requires polymer chains with at least three modelled anchors.',
    );
  return {
    chain,
    members,
    sequence: members.map((r) => ONE_LETTER[resNameOf(s, r)] ?? 'X').join(''),
  };
}
export function compareInterfaceSides(
  rs: Structure,
  ms: Structure,
  reference: ChainInterface,
  mobile: ChainInterface,
  reverse: boolean,
) {
  return [0, 1].map((side) => {
    const rr = side ? reference.residueIndicesB : reference.residueIndicesA;
    const mr =
      Boolean(side) !== reverse
        ? mobile.residueIndicesB
        : mobile.residueIndicesA;
    const r = chainAt(rs, rr),
      m = chainAt(ms, mr);
    if (rs.chainKind[r.chain] !== ms.chainKind[m.chain])
      throw new Error(
        'The selected sides contain different polymer types. Reverse the side pairing or choose another interface.',
      );
    if (r.members.length * m.members.length > 25_000_000)
      throw new Error(
        'These chains exceed the 25-million-cell alignment limit. Choose smaller chains.',
      );
    const pairs = alignSequences(
      r.sequence,
      m.sequence,
      rs.chainKind[r.chain] === MolKind.Nucleic,
    );
    const rset = new Set(rr),
      mset = new Set(mr);
    const pairedR = new Set<number>(),
      pairedM = new Set<number>();
    let identical = 0;
    const contacts = pairs.flatMap(([a, b]) => {
      const ri = r.members[a],
        mi = m.members[b];
      pairedR.add(ri);
      pairedM.add(mi);
      if (r.sequence[a] === m.sequence[b]) identical++;
      const referenceContact = rset.has(ri),
        mobileContact = mset.has(mi);
      return referenceContact || mobileContact
        ? [
            {
              referenceResidue: ri,
              mobileResidue: mi,
              referenceContact,
              mobileContact,
            },
          ]
        : [];
    });
    return {
      referenceChain: r.chain,
      mobileChain: m.chain,
      matched: pairs.length,
      identity: pairs.length ? identical / pairs.length : 0,
      referenceCoverage: pairs.length / r.members.length,
      mobileCoverage: pairs.length / m.members.length,
      conserved: contacts.filter((p) => p.referenceContact && p.mobileContact)
        .length,
      lost: contacts.filter((p) => p.referenceContact && !p.mobileContact)
        .length,
      gained: contacts.filter((p) => !p.referenceContact && p.mobileContact)
        .length,
      unmappedReference: rr.filter((r) => !pairedR.has(r)),
      unmappedMobile: mr.filter((r) => !pairedM.has(r)),
      contacts,
    };
  });
}
