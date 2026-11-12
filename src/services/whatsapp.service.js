import { GRAPH_API_URL } from '../config/meta.js';

class WhatsAppService {
  getGraphUrl(config) {
    if (!config?.accessToken || !config?.phoneNumberId || !config?.wabaId) {
      throw new Error('WhatsApp no está configurado para esta empresa');
    }
    return {
      baseUrl: `${GRAPH_API_URL}/${config.phoneNumberId}`,
      wabaUrl: `${GRAPH_API_URL}/${config.wabaId}`,
      accessToken: config.accessToken,
    };
  }

  /**
   * Fetch every message template of the account with its status, quality and rejection reason
   */
  async getTemplates(config) {
    try {
      const { wabaUrl, accessToken } = this.getGraphUrl(config);
      const fields = 'id,name,language,status,category,rejected_reason,quality_score,components';
      const response = await fetch(`${wabaUrl}/message_templates?fields=${fields}&limit=200`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error fetching WhatsApp templates');
      }

      return data.data || [];
    } catch (error) {
      console.error('WhatsApp Service Error (getTemplates):', error);
      throw error;
    }
  }

  async createTemplate(config, data) {
    try {
      const { wabaUrl, accessToken } = this.getGraphUrl(config);
      const response = await fetch(`${wabaUrl}/message_templates`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();
      if (!response.ok) {
        // Meta explains the rejection in error_user_msg; message alone says «Invalid parameter»
        const detail = [result.error?.error_user_title, result.error?.error_user_msg].filter(Boolean).join(': ');
        throw new Error(detail || result.error?.message || 'Error creating WhatsApp template');
      }

      return result;
    } catch (error) {
      console.error('WhatsApp Service Error (createTemplate):', error);
      throw error;
    }
  }

  /**
   * Edit a template (Meta allows it for rejected, paused or approved ones); it goes back to review
   */
  async editTemplate(config, templateId, data) {
    this.getGraphUrl(config);
    const response = await fetch(`${GRAPH_API_URL}/${templateId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      const detail = [result.error?.error_user_title, result.error?.error_user_msg].filter(Boolean).join(': ');
      throw new Error(detail || result.error?.message || 'Error editing WhatsApp template');
    }
    return result;
  }

  async deleteTemplate(config, name) {
    try {
      const { wabaUrl, accessToken } = this.getGraphUrl(config);
      const response = await fetch(`${wabaUrl}/message_templates?name=${name}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message || 'Error deleting WhatsApp template');
      }

      return result;
    } catch (error) {
      console.error('WhatsApp Service Error (deleteTemplate):', error);
      throw error;
    }
  }

  /**
   * Send a text message to a customer
   */
  async sendTextMessage(config, to, text) {
    try {
      const { baseUrl, accessToken } = this.getGraphUrl(config);
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: this.formatPhoneNumber(to),
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error sending WhatsApp message');
      }

      return data;
    } catch (error) {
      console.error('WhatsApp Service Error:', error);
      throw error;
    }
  }

  /**
   * Send a template message (required for initiating conversations)
   */
  async sendTemplateMessage(config, to, templateName, languageCode = 'es', components = []) {
    try {
      const { baseUrl, accessToken } = this.getGraphUrl(config);
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: this.formatPhoneNumber(to),
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components,
          },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error sending WhatsApp template');
      }

      return data;
    } catch (error) {
      console.error('WhatsApp Service Error:', error);
      throw error;
    }
  }

  /**
   * Format phone number to E.164 without '+'
   */
  formatPhoneNumber(phone) {
    // Remove all non-numeric characters
    let cleaned = phone.toString().replace(/\D/g, '');
    
    // Colombia specific: if it has 10 digits (starts with 3), add 57
    if (cleaned.length === 10 && cleaned.startsWith('3')) {
      cleaned = '57' + cleaned;
    }
    
    return cleaned;
  }
}

export const whatsappService = new WhatsAppService();
