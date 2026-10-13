window.CONFIG = {
  title: "Tableau de bord",
  stateRefreshSeconds: 10,    // public pages: poll rate of /api/state (also sets the "online viewers" window)
  adminRefreshSeconds: 3,     // admin page: poll rate
  adminSessionSeconds: 1800,  // admin cookie lifetime, renewed on every admin action
};
