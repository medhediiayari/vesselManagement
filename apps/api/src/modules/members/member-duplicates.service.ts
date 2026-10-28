import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Db, PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { memberVisibilityWhere } from '../access/member-access';
import {
  DUPLICATE_REASON_LABELS,
  DuplicateCandidate,
  IdentityRecord,
  MemberIdentity,
  OUT_OF_SCOPE_DUPLICATE_MESSAGE,
  identityKeys,
  partitionCandidates,
  rankCandidates,
  ymd,
} from './members.logic';

interface IdentityRow {
  id: string;
  amcRef: string | null;
  firstName: string;
  lastName: string;
  birthDate: Date | null;
  passportNumber: string | null;
  passportCountry: string | null;
  seamanBookNumber: string | null;
  archivedAt: Date | null;
}

/**
 * Recherche des fiches existantes ressemblant à une ou plusieurs identités (ADM-042).
 * Pré-filtrage SQL sur clés normalisées (matricule, passeport, seaman book, couple nom|prénom
 * via unaccent, date de naissance) puis scoring en mémoire (members.logic). La recherche porte
 * sur TOUTES les fiches (archivées comprises) : la déduplication ne dépend pas du périmètre ADM-070,
 * seul l'affichage des candidats y est soumis.
 */
@Injectable()
export class MemberDuplicatesService {
  constructor(private readonly prisma: PrismaService) {}

  async loadCandidates(probes: MemberIdentity[], db: Db = this.prisma): Promise<IdentityRecord[]> {
    const refs = new Set<string>();
    const passports = new Set<string>();
    const books = new Set<string>();
    const pairs = new Set<string>();
    const dates = new Set<string>();
    for (const p of probes) {
      const k = identityKeys(p);
      if (k.ref) refs.add(k.ref);
      if (k.passport) passports.add(k.passport);
      if (k.book) books.add(k.book);
      k.namePairs.forEach((x) => pairs.add(x));
      if (k.birthDate) dates.add(k.birthDate);
    }
    // Listes IN (...) de paramètres texte : pas de tableau typé (types instables sur requête préparée réutilisée)
    const conditions: Prisma.Sql[] = [];
    const inList = (expr: Prisma.Sql, values: Set<string>) => {
      if (values.size) conditions.push(Prisma.sql`${expr} IN (${Prisma.join([...values])})`);
    };
    inList(Prisma.sql`regexp_replace(upper(coalesce(amc_ref, '')), '[^A-Z0-9]', '', 'g')`, refs);
    inList(Prisma.sql`regexp_replace(upper(coalesce(passport_number, '')), '[^A-Z0-9]', '', 'g')`, passports);
    inList(Prisma.sql`regexp_replace(upper(coalesce(seaman_book_number, '')), '[^A-Z0-9]', '', 'g')`, books);
    inList(
      Prisma.sql`(regexp_replace(upper(unaccent(last_name)), '[^A-Z]', '', 'g') || '|' || regexp_replace(upper(unaccent(first_name)), '[^A-Z]', '', 'g'))`,
      pairs,
    );
    inList(Prisma.sql`to_char(birth_date, 'YYYY-MM-DD')`, dates);
    if (!conditions.length) return [];
    const rows = await db.$queryRaw<IdentityRow[]>(Prisma.sql`
      SELECT id, amc_ref AS "amcRef", first_name AS "firstName", last_name AS "lastName", birth_date AS "birthDate",
             passport_number AS "passportNumber", passport_country AS "passportCountry",
             seaman_book_number AS "seamanBookNumber", archived_at AS "archivedAt"
      FROM members
      WHERE ${Prisma.join(conditions, ' OR ')}
      LIMIT 20000`);
    return rows.map((r) => ({
      id: r.id,
      amcRef: r.amcRef,
      firstName: r.firstName,
      lastName: r.lastName,
      birthDate: ymd(r.birthDate),
      passportNumber: r.passportNumber,
      passportCountry: r.passportCountry,
      seamanBookNumber: r.seamanBookNumber,
      archived: !!r.archivedAt,
    }));
  }

  async find(probe: MemberIdentity, opts: { excludeIds?: string[]; db?: Db; limit?: number } = {}): Promise<DuplicateCandidate[]> {
    const records = await this.loadCandidates([probe], opts.db ?? this.prisma);
    return rankCandidates(probe, records, { excludeIds: opts.excludeIds, limit: opts.limit ?? 10 });
  }

  /** Identifiants de fiches visibles de l'utilisateur parmi `ids` (ADM-070). */
  async visibleIds(ctx: AuthContext, ids: string[], db: Db = this.prisma): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db.member.findMany({ where: { AND: [{ id: { in: [...new Set(ids)] } }, memberVisibilityWhere(ctx)] }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Présentation des candidats : détail (identité, score, raisons) uniquement pour les fiches visibles
   * (ADM-070). Toutes les fiches invisibles sont réduites à UNE mention générique « doublon possible
   * hors périmètre » — ni identifiant, ni score, ni raisons : pas d'oracle sur date de naissance /
   * passeport. La création reste bloquée (409) tant que l'utilisateur ne force pas avec un motif.
   */
  async present(ctx: AuthContext, candidates: DuplicateCandidate[], db: Db = this.prisma) {
    if (!candidates.length) return [];
    const visible = await db.member.findMany({
      where: { AND: [{ id: { in: candidates.map((c) => c.memberId) } }, memberVisibilityWhere(ctx)] },
      select: {
        id: true, amcRef: true, firstName: true, lastName: true, birthDate: true, nationality: true,
        passportNumber: true, seamanBookNumber: true, rank: true, status: true, archivedAt: true,
      },
    });
    const byId = new Map(visible.map((m) => [m.id, m]));
    const { visible: shown, hiddenMatch } = partitionCandidates(candidates, new Set(byId.keys()));
    return [
      ...shown.map((c) => {
        const m = byId.get(c.memberId)!;
        return {
          memberId: c.memberId as string | null,
          score: c.score as number | null,
          reasons: c.reasons as string[],
          reasonLabels: c.reasons.map((r) => DUPLICATE_REASON_LABELS[r]),
          archived: c.archived,
          visible: true,
          member: { ...m, birthDate: ymd(m.birthDate) } as Record<string, unknown> | null,
          message: null as string | null,
        };
      }),
      ...(hiddenMatch
        ? [{ memberId: null, score: null, reasons: [], reasonLabels: [], archived: false, visible: false, member: null, message: OUT_OF_SCOPE_DUPLICATE_MESSAGE }]
        : []),
    ];
  }
}
