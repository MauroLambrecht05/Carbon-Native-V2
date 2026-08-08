// App — root layout with theme provider + sidebar + editor.

import { useNotes } from "./notes.ts";
import { ThemeProvider, useTheme } from "./theme.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Editor } from "./Editor.tsx";
import { Divider } from "./components.tsx";

function Layout() {
  const { colors } = useTheme();
  const api = useNotes();
  return (
    <view
      style={{
        flexDirection: "row",
        background: colors.bg,
        flexGrow: 1,
        height: "100%",
      }}
    >
      <Sidebar api={api} />
      <Divider vertical />
      <Editor api={api} />
    </view>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Layout />
    </ThemeProvider>
  );
}
