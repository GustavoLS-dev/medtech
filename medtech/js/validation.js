/* ==========================================================================
   MedTech — validation.js
   Regras de validação e exibição de erros nos campos.
   A validação no navegador melhora a experiência, mas NÃO substitui a
   validação no servidor (Supabase Auth, restrições do banco e RLS).
   Depende de: icons.js
   ========================================================================== */

const Validation = (function () {
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const PASSWORD_MIN = 8;

  /* ---------------- Regras ----------------
     Cada regra recebe o valor do campo e devolve uma mensagem de erro,
     ou uma string vazia quando o valor é válido. */
  const rules = {
    required: function (message) {
      return function (value) {
        return String(value).trim() === "" ? (message || "Preencha este campo.") : "";
      };
    },

    email: function () {
      return function (value) {
        const v = String(value).trim();
        if (v === "") return "Informe seu e-mail.";
        return EMAIL_PATTERN.test(v) ? "" : "Digite um e-mail válido, como nome@exemplo.com.";
      };
    },

    fullName: function () {
      return function (value) {
        const v = String(value).trim();
        if (v === "") return "Informe seu nome completo.";
        if (v.length < 3) return "O nome deve ter pelo menos 3 caracteres.";
        if (v.split(/\s+/).length < 2) return "Informe nome e sobrenome.";
        if (v.length > 120) return "O nome deve ter no máximo 120 caracteres.";
        return "";
      };
    },

    password: function () {
      return function (value) {
        if (value === "") return "Informe uma senha.";
        if (value.length < PASSWORD_MIN) return "A senha deve ter pelo menos " + PASSWORD_MIN + " caracteres.";
        if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return "Use letras e números na senha.";
        return "";
      };
    },

    /** O valor precisa ser igual ao de outro campo (ex.: confirmar senha). */
    matches: function (otherFieldId, message) {
      return function (value) {
        const other = document.getElementById(otherFieldId);
        if (value === "") return "Confirme a senha.";
        return other && value !== other.value ? (message || "As senhas não coincidem.") : "";
      };
    }
  };

  /** Pontuação de 0 a 4 usada no medidor visual de força da senha. */
  function passwordStrength(value) {
    let score = 0;
    if (value.length >= PASSWORD_MIN) score++;
    if (value.length >= 12) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
    return value === "" ? 0 : Math.max(1, score);
  }

  /* ---------------- Exibição de erros ---------------- */
  function errorElementFor(input) {
    return document.getElementById(input.id + "-error");
  }

  function showError(input, message) {
    const field = input.closest(".field");
    const errorEl = errorElementFor(input);
    if (field) field.classList.add("has-error");
    input.setAttribute("aria-invalid", "true");
    if (errorEl) {
      errorEl.innerHTML = Icons.get("alertCircle") + "<span></span>";
      errorEl.querySelector("span").textContent = message;
    }
  }

  function clearError(input) {
    const field = input.closest(".field");
    const errorEl = errorElementFor(input);
    if (field) field.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
    if (errorEl) errorEl.textContent = "";
  }

  function validateField(input, fieldRules) {
    for (let i = 0; i < fieldRules.length; i++) {
      const message = fieldRules[i](input.value);
      if (message) {
        showError(input, message);
        return false;
      }
    }
    clearError(input);
    return true;
  }

  /**
   * Liga a validação a um formulário.
   * schema: { idDoCampo: [regra1, regra2, ...] }
   * onValid: função chamada com os valores quando tudo estiver correto.
   *
   * Os erros aparecem ao sair do campo e ao enviar o formulário.
   * Depois do primeiro erro, o campo é revalidado enquanto o usuário digita.
   */
  function bindForm(form, schema, onValid) {
    form.setAttribute("novalidate", ""); // usamos nossas mensagens em português

    Object.keys(schema).forEach(function (id) {
      const input = document.getElementById(id);
      if (!input) return;
      // Leitores de tela leem a mensagem de erro junto com o campo
      const describedBy = ((input.getAttribute("aria-describedby") || "") + " " + id + "-error").trim();
      input.setAttribute("aria-describedby", describedBy);

      input.addEventListener("blur", function () {
        if (input.value !== "") validateField(input, schema[id]);
      });
      input.addEventListener("input", function () {
        if (input.getAttribute("aria-invalid") === "true") validateField(input, schema[id]);
      });
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      let firstInvalid = null;
      const values = {};

      Object.keys(schema).forEach(function (id) {
        const input = document.getElementById(id);
        if (!input) return;
        const ok = validateField(input, schema[id]);
        if (!ok && !firstInvalid) firstInvalid = input;
        values[id] = input.value;
      });

      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }
      onValid(values, event);
    });
  }

  return {
    rules: rules,
    PASSWORD_MIN: PASSWORD_MIN,
    passwordStrength: passwordStrength,
    showError: showError,
    clearError: clearError,
    bindForm: bindForm
  };
})();
