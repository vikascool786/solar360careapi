function buildTemplatePayload(template, phone, bodyParams = []) {
  const components = [];

  // HEADER
  if (template.header_type === "IMAGE") {
    components.push({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: "https://solar360care.com/wp-content/uploads/2026/03/solar-panel-cleaning-nagpur-2.jpeg",
          },
        },
      ],
    });
  }

  // BODY PARAMS
  if (template.has_body_params && bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((p) => ({
        type: "text",
        text: p,
      })),
    });
  }

  return {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: template.name,
      language: { code: "en" },
      components,
    },
  };
}

module.exports = { buildTemplatePayload };