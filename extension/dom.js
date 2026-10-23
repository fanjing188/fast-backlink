(function(root) {
  function label(element, doc = document) {
    const text = node => node?.textContent?.trim() || '';
    const labelText = node => {
      if (node.nodeType === 3) return node.textContent;
      if (['INPUT','SELECT','TEXTAREA','BUTTON','OPTION'].includes(node.tagName)) return '';
      return [...node.childNodes].map(labelText).join('');
    };
    return [...(element.labels || [])].map(node => labelText(node).trim()).filter(Boolean).join(' ') || element.getAttribute('aria-label') ||
      (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(doc.getElementById(id))).filter(Boolean).join(' ') ||
      element.getAttribute('placeholder') || text(element.previousElementSibling) || element.name || element.id || '';
  }
  function describe(element, rules, doc = document) {
    const field = {label:label(element,doc), name:[element.name,element.id].filter(Boolean).join(' '), inputType:element.type || 'contenteditable', autocomplete:element.autocomplete || '', required:element.required || element.getAttribute('aria-required') === 'true', maxlength:element.maxLength ?? -1, role:element.getAttribute('role') || (element.tagName === 'SELECT' ? 'combobox' : 'textbox')};
    field.groupLabel = element.closest?.('fieldset')?.querySelector('legend')?.textContent?.trim() || '';
    if (BKLogic.sensitive({...field,label:field.label+' '+field.groupLabel},rules)) return {...field, sensitive:true};
    if (element.options) field.options = [...element.options].filter(o => !o.disabled).map(o => o.textContent.trim());
    if (field.inputType === 'checkbox') field.options = [field.label];
    if (field.inputType === 'radio') field.options = [...doc.querySelectorAll('input[type=radio]')].filter(e => e.name === element.name && e.form === element.form).map(e => label(e,doc));
    return field;
  }
  function read(element, field) {
    if (field.sensitive || field.inputType === 'file') return undefined;
    if (['radio','checkbox'].includes(field.inputType)) return element.checked ? field.label : '';
    if (element.options && element.value === '') return '';
    if (element.options) return [...element.selectedOptions].map(o => o.textContent.trim()).join(', ');
    return element.isContentEditable ? element.textContent : element.value;
  }
  function set(element, property, value) {
    let prototype = Object.getPrototypeOf(element), setter;
    while (prototype && !setter) {setter = Object.getOwnPropertyDescriptor(prototype,property)?.set; prototype = Object.getPrototypeOf(prototype);}
    if (setter) setter.call(element,value); else element[property] = value;
    const EventClass = element.ownerDocument.defaultView.Event;
    element.dispatchEvent(new EventClass('input',{bubbles:true}));
    element.dispatchEvent(new EventClass('change',{bubbles:true}));
  }
  async function fill(element, field, value, getFile) {
    if (field.sensitive || value === undefined || element.disabled || element.readOnly) return false;
    if (field.inputType === 'file') {
      const image = await getFile(value.id), bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes],value.name,{type:image.type}));
      set(element,'files',transfer.files); return element.files.length > 0;
    }
    if (['checkbox','radio'].includes(field.inputType)) {set(element,'checked',true); return element.checked;}
    if (element.options) {
      const options = [...element.options].filter(o => !o.disabled && o.textContent.trim() === value);
      if (options.length !== 1) return false;
      set(element,'value',options[0].value); return element.value === options[0].value;
    }
    if (element.isContentEditable) {element.textContent = String(value); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return element.textContent === String(value);}
    set(element,'value',String(value)); return element.value === String(value);
  }
  root.BKDom = {label, describe, read, set, fill};
  if (typeof module !== 'undefined') module.exports = root.BKDom;
})(globalThis);
