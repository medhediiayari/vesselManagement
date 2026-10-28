import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly } from '../../common/pagination';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).nullable().optional();

const AssignmentFields = {
  rank: z.string().trim().min(1).max(120),
  position: text(120),
  plannedJoinDate: dateOnly.nullable().optional(),
  plannedSignOffDate: dateOnly.nullable().optional(),
  joinPort: text(120),
  voyageId: uuid.nullable().optional(),
  /** Relève : affectation (même navire) que celle-ci remplace */
  relievesAssignmentId: uuid.nullable().optional(),
  notes: text(5000),
};

const datesOrdered = (d: { plannedJoinDate?: Date | null; plannedSignOffDate?: Date | null }) =>
  !d.plannedJoinDate || !d.plannedSignOffDate || d.plannedSignOffDate >= d.plannedJoinDate;
const datesMessage = { message: 'Débarquement prévu antérieur à l’embarquement prévu', path: ['plannedSignOffDate'] };

export const PlanAssignmentSchema = z.object({ memberId: uuid, vesselId: uuid, ...AssignmentFields }).refine(datesOrdered, datesMessage);
export class PlanAssignmentDto extends createZodDto(PlanAssignmentSchema) {}

/** Planification depuis le navire (/vessels/:vesselId/crew) : le navire vient de l'URL. */
export class PlanVesselAssignmentDto extends createZodDto(z.object({ memberId: uuid, ...AssignmentFields }).refine(datesOrdered, datesMessage)) {}

export class UpdateAssignmentDto extends createZodDto(
  z
    .object({
      rank: z.string().trim().min(1).max(120).optional(),
      position: text(120),
      plannedJoinDate: dateOnly.nullable().optional(),
      plannedSignOffDate: dateOnly.nullable().optional(),
      joinPort: text(120),
      signOffPort: text(120),
      voyageId: uuid.nullable().optional(),
      relievesAssignmentId: uuid.nullable().optional(),
      notes: text(5000),
      /** Verrou optimiste : `updatedAt` lu par le client */
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
) {}

export class JoinAssignmentDto extends createZodDto(
  z.object({
    actualJoinDate: dateOnly,
    joinPort: text(120),
    /** Relève : débarque l'affectation relevée (même navire) à la même date, dans la même transaction */
    signOffRelieved: z.boolean().default(false),
  }),
) {}

export class SignOffAssignmentDto extends createZodDto(
  z.object({ actualSignOffDate: dateOnly, signOffPort: text(120), notes: text(5000) }),
) {}

export class CancelAssignmentDto extends createZodDto(z.object({ reason: z.string().trim().min(3).max(500) })) {}

export class ListAssignmentsQuery extends createZodDto(
  PaginationSchema.extend({
    vesselId: uuid.optional(),
    memberId: uuid.optional(),
    status: z.enum(['PLANNED', 'ONBOARD', 'COMPLETED', 'CANCELLED']).optional(),
    /** Période (chevauchement avec les dates réelles ou prévues) */
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  }),
) {}

export class RosterQuery extends createZodDto(z.object({ date: dateOnly.optional() })) {}
