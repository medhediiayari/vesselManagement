'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';

type Settings = {
  'auth.sessionIdleTimeoutMinutes': number;
  'auth.maxFailedLogins': number;
  'auth.passwordMinLength': number;
  'members.selfEditableFields': string[];
  'files.maxUploadBytes': number;
  'certificates.expiringSoonDays': number;
  'purchasing.allowOverAllocation': boolean;
};

const SELF_FIELDS: [string, string][] = [
  ['email', 'E-mail personnel'],
  ['phone', 'Téléphone'],
  ['address', 'Adresse'],
  ['emergencyContactName', "Contact d'urgence (nom)"],
  ['emergencyContactPhone', "Contact d'urgence (téléphone)"],
];

/** Paramètres laissés configurables au Super Admin (CDC §17.1). */
export default function SettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings'), enabled: can('settings.manage') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);

  if (!can('settings.manage')) return <Forbidden />;
  if (q.isLoading || !s) return q.error ? <ErrorState error={q.error} /> : <LoadingBlock rows={6} />;

  async function save<K extends keyof Settings>(key: K, value: Settings[K]) {
    try {
      await api.patch(`/settings/${key}`, { value });
      toast.success('Paramètre enregistré');
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const NumberSetting = ({ k, label, hint, min, max, unit }: { k: keyof Settings; label: string; hint: string; min: number; max: number; unit?: string }) => (
    <div className="flex flex-wrap items-end gap-2 border-b border-line py-3 last:border-0">
      <Field label={label} hint={hint} className="min-w-[260px] flex-1" htmlFor={`s-${k}`}>
        <div className="flex items-center gap-2">
          <Input id={`s-${k}`} type="number" min={min} max={max} className="w-32" value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
          {unit && <span className="text-sm text-ink-muted">{unit}</span>}
        </div>
      </Field>
      <Button variant="secondary" size="sm" onClick={() => save(k, s[k])} disabled={s[k] === q.data?.[k]}>Enregistrer</Button>
    </div>
  );

  return (
    <>
      <PageHeader title="Paramètres" description="Chaque modification est journalisée. Les valeurs métier non décidées par AMC (seuils financiers) restent à configurer dans leurs modules." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Sécurité des sessions">
          <NumberSetting k="auth.sessionIdleTimeoutMinutes" label="Expiration après inactivité" hint="ADM-016 — appliquée à toutes les sessions" min={5} max={1440} unit="minutes" />
          <NumberSetting k="auth.maxFailedLogins" label="Échecs avant verrouillage" hint="ADM-014 — 5 par décision AMC" min={3} max={10} />
          <NumberSetting k="auth.passwordMinLength" label="Longueur minimale du mot de passe" hint="12 recommandé (pas de MFA, ADM-013)" min={10} max={128} unit="caractères" />
        </Panel>
        <Panel title="Fichiers et certificats">
          <NumberSetting k="files.maxUploadBytes" label="Taille maximale d'un dépôt" hint="Limite serveur absolue fixée par l'environnement" min={1048576} max={524288000} unit="octets" />
          <NumberSetting k="certificates.expiringSoonDays" label="Seuil « expire bientôt »" hint="Statut d'affichage ; les rappels suivent la politique de chaque type" min={1} max={365} unit="jours" />
        </Panel>
        <Panel title="Coordonnées modifiables par l'utilisateur" actions={<Button size="sm" variant="secondary" onClick={() => save('members.selfEditableFields', s['members.selfEditableFields'])}>Enregistrer</Button>}>
          <p className="mb-3 text-sm text-ink-muted">ADM-035 — champs de la fiche Member qu’un utilisateur lié peut mettre à jour lui-même (effet immédiat, audité).</p>
          <div className="space-y-2">
            {SELF_FIELDS.map(([k, l]) => (
              <Checkbox
                key={k}
                label={l}
                checked={s['members.selfEditableFields'].includes(k)}
                onChange={(e) =>
                  setS({ ...s, 'members.selfEditableFields': e.target.checked ? [...s['members.selfEditableFields'], k] : s['members.selfEditableFields'].filter((x) => x !== k) })
                }
              />
            ))}
          </div>
        </Panel>
        <Panel title="Achats">
          <Checkbox
            label="Autoriser la sur-allocation explicite"
            description="Une quantité commandée supérieure à la quantité approuvée exige alors un motif et reste tracée. Désactivé par défaut (politique à confirmer par AMC)."
            checked={s['purchasing.allowOverAllocation']}
            onChange={(e) => {
              setS({ ...s, 'purchasing.allowOverAllocation': e.target.checked });
              save('purchasing.allowOverAllocation', e.target.checked);
            }}
          />
        </Panel>
      </div>
    </>
  );
}
