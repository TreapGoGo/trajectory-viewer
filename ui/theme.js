// Day / night theme. Loaded as a classic script in <head> so data-theme is set
// before the first paint (no flash). A choice made with the top-bar button is
// remembered in this browser; without one the page follows the system setting.
(function () {
  var KEY = "workbench-theme";
  var root = document.documentElement;
  var system = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "dark" || value === "light" ? value : "";
    } catch (error) {
      return "";
    }
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
  }
  function current() {
    return saved() || (system && system.matches ? "dark" : "light");
  }

  apply(current());
  if (system && system.addEventListener) {
    system.addEventListener("change", function () {
      if (!saved()) apply(current());
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    button.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (error) {
        /* private mode: the switch still works for this page */
      }
    });
  });
})();
