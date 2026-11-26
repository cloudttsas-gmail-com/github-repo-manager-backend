import TemplateVersion from '../models/TemplateVersion.js';
import TemplateMedia from '../models/TemplateMedia.js';

/**
 * History of a project's WhatsApp templates. Every create, edit and restore made from Operix is
 * recorded with who did it and under which role; the first time a template is changed, its version
 * in Meta is kept first (`found`), so there is always something to go back to.
 */

const key = (company, template) => ({ companyId: company._id, name: template.name, language: template.language });

/** { userId, name, role } of the person acting, or undefined for Operix itself. */
export const actorOf = (user) => (user ? { userId: user.userId, name: user.fullName || '', role: user.role || '' } : undefined);

const mediaOf = async (company, template) => {
  const media = await TemplateMedia.findOne(key(company, template)).lean();
  return media ? { source: media.source, fileUrl: media.fileUrl, fileName: media.fileName } : undefined;
};

/** Records one version. `template` is { id?, name, language, category?, parameter_format?, components }. */
export const recordVersion = async (company, template, { action, actor, restoredFrom } = {}) => TemplateVersion.create({
  tenantId: company.tenantId,
  companyId: company._id,
  templateId: template.id ? String(template.id) : undefined,
  name: template.name,
  language: template.language,
  category: template.category,
  parameterFormat: template.parameter_format,
  components: template.components || [],
  media: await mediaOf(company, template),
  action,
  restoredFrom,
  by: actor,
});

/** Keeps the template as Meta has it now when Operix has no version of it yet. */
export const ensureBaseline = async (company, current) => {
  if (await TemplateVersion.exists(key(company, current))) return;
  await recordVersion(company, current, { action: 'found' });
};

/** Versions of a template, newest first. */
export const listVersions = (company, template) => TemplateVersion.find(key(company, template)).sort({ createdAt: -1, _id: -1 }).lean();

export const findVersion = (company, template, versionId) => TemplateVersion.findOne({ ...key(company, template), _id: versionId }).lean();
