// A view window's tab when what it was opened for isn't on this computer: it shows only that one thing, so there is
// nothing to pick from and nothing to join.
export default function NothingToShow(props: { what: string }) {
  return (
    <div class="empty-state mw-fade-in">
      <h2>Nothing to show</h2>
      <p>{props.what} isn't open on this computer. Close this window and open it again from the main window.</p>
    </div>
  );
}
