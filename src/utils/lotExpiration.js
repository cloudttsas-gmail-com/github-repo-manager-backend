import Lot from '../models/Lot.js';
import { logAudit } from './auditLogger.js';

/**
 * Checks for expired reservations (apartado and separado) and releases them.
 * - 'apartado': maximum 5 days.
 * - 'separado': maximum 1 month (30 days).
 */
export const checkLotExpirations = async (tenantId, companyId) => {
  try {
    const now = new Date();
    
    // 1. Release expired lots (using expiresAt if available, fallback to reservedAt)
    const fiveDaysAgo = new Date(now);
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const expiredLots = await Lot.find({
      tenantId,
      companyId,
      isDeleted: { $ne: true },
      status: { $in: ['apartado', 'separado'] },
      $or: [
        { expiresAt: { $lt: now } },
        { 
          $and: [
            { expiresAt: { $exists: false } },
            {
              $or: [
                { status: 'apartado', reservedAt: { $lt: fiveDaysAgo } },
                { status: 'separado', reservedAt: { $lt: oneMonthAgo } }
              ]
            }
          ]
        }
      ]
    });

    for (const lot of expiredLots) {
      const oldStatus = lot.status;
      const oldReservedBy = lot.reservationBy;
      
      lot.status = 'disponible';
      lot.reservedAt = undefined;
      lot.expiresAt = undefined;
      lot.reservationBy = undefined;
      lot.reservationDetails = undefined;
      lot.reservationAmount = undefined;
      // The seller came with the reservation: an available lot belongs to nobody
      lot.sellerId = undefined;
      await lot.save();

      // Log the automatic release
      await logAudit({ user: { tenantId, companyId, role: 'system' } }, {
        action: 'AUTO_RELEASE_LOT',
        module: 'LOTS',
        targetId: lot._id,
        details: { 
          reason: `${oldStatus} expired`, 
          previousStatus: oldStatus,
          client: oldReservedBy
        }
      });
    }

    return {
      releasedLots: expiredLots.length,
    };

  } catch (error) {
    console.error('Error in checkLotExpirations:', error);
    return { error: error.message };
  }
};
