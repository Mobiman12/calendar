export type AppointmentRow = {
  id: string;
  startsAtIso: string;
  customerName: string;
  customerContact?: string;
  serviceName: string;
  staffName: string;
  status: string;
  totalAmount: number;
  currency: string;
};

export interface AppointmentDetailPayload {
  appointment: {
    id: string;
    confirmationCode: string;
    status: string;
    paymentStatus: string;
    source: string;
    startsAt: string;
    endsAt: string;
    createdAt: string;
    updatedAt: string;
    totalAmount: number;
    depositAmount: number | null;
    currency: string;
    note: string | null;
    internalNote: string | null;
    internalNoteIsTitle?: boolean | null;
    cancelReason: string | null;
    metadata: unknown;
    durationMinutes: number;
    customer: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      notes: string | null;
    } | null;
    items: Array<{
      id: string;
      status: string;
      startsAt: string;
      endsAt: string;
      price: number;
      currency: string;
      notes: string | null;
      service: { id: string; name: string; duration: number } | null;
      staff: { id: string; name: string } | null;
      resource: { id: string; name: string; type: string } | null;
    }>;
    attachments: Array<{
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      createdAt: string;
    }>;
    notifications: Array<{
      id: string;
      channel: string;
      trigger: string;
      type: string;
      status: string;
      scheduledAt: string | null;
      sentAt: string | null;
      createdAt: string;
      error: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    paymentHistory: Array<{
      status: string;
      note: string | null;
      amount: number | null;
      currency: string | null;
      at: string;
    }>;
  };
  auditTrail: Array<{
    id: string;
    action: string;
    actorType: string;
    actor: { id: string; email: string | null; name: string | null } | null;
    context: unknown;
    diff: unknown;
    createdAt: string;
  }>;
  ics: string;
}
