'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useSession } from '@/lib/session';
import { PageHeader, Panel } from '@/components/ui/page';
import { Forbidden, LoadingBlock } from '@/components/ui/states';
import { ReceivablePoSelect } from '@/components/purchasing/delivery-note-dialog';
import { OnboardBlForm } from '@/components/purchasing/onboard-bl-form';

export default function ReceivePage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Receive />
    </Suspense>
  );
}

/**
 * Réponse du bord à un BC : BL + réception en une étape (saisie des quantités ou fichier joint). Tout utilisateur
 * du navire habilité (receiving.record) qui voit le BC peut la saisir ; les écarts sont signalés aux Achats.
 */
function Receive() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, selectedVesselIds } = useSession();
  const poId = sp.get('poId') ?? '';
  if (!can('receiving.record')) return <Forbidden message="La saisie d’un BL requiert la permission receiving.record." />;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Livraisons & réceptions', href: '/purchasing/deliveries' }, { label: 'Répondre par un BL' }]}
        title="Répondre au BC par un BL"
        description="À la livraison : saisissez les quantités reçues ou joignez le BL du fournisseur. Les écarts sont signalés aux Achats ; le BC se clôture quand tout est reçu."
      />
      {!poId ? (
        <Panel title="Bon de commande livré">
          <div className="max-w-xl">
            <ReceivablePoSelect value="" onChange={(id) => id && router.replace(`/purchasing/deliveries/receive?poId=${id}`)} vesselId={selectedVesselIds.length === 1 ? selectedVesselIds[0] : undefined} />
          </div>
        </Panel>
      ) : (
        <OnboardBlForm key={poId} poId={poId} />
      )}
    </>
  );
}
