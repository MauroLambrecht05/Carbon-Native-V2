// App — top-level layout. Four columns side-by-side:
//   server rail (72) | channel sidebar (240) | message stream (flex) | member list (240, optional)
//
// Total chrome at default 1440×900 viewport: 552 px → main pane gets 888 px,
// roughly the same as Discord's at the same viewport. Works at any width
// because the message stream is flex-grow:1.

import { ThemeProvider } from "./theme.tsx";
import { ServerRail } from "./components/ServerRail.tsx";
import { ChannelSidebar } from "./components/ChannelSidebar.tsx";
import { MessageStream } from "./components/MessageStream.tsx";
import { MessageInput } from "./components/MessageInput.tsx";
import { MemberList } from "./components/MemberList.tsx";
import { useChatStore } from "./store.ts";
import {
  CHANNELS_BY_SERVER,
  SERVERS,
  USERS,
} from "./data/mock.ts";
import { useTheme } from "./theme.tsx";

function Layout() {
  const { colors, name: themeName } = useTheme();
  const store = useChatStore();

  const server = SERVERS.find((s) => s.id === store.serverId) ?? SERVERS[1];
  const categories = CHANNELS_BY_SERVER[store.serverId] ?? [];
  const allChannels = categories.flatMap((c) => c.channels);
  const channel =
    allChannels.find((c) => c.id === store.channelId) ?? allChannels[0];

  return (
    <view
      style={{
        flexDirection: "row",
        background: colors.serverRailBg,
        flexGrow: 1,
        height: "100%",
      }}
    >
      <ServerRail
        servers={SERVERS}
        activeId={store.serverId}
        onSelect={store.selectServer}
      />
      <ChannelSidebar
        server={server}
        categories={categories}
        activeChannelId={store.channelId}
        onSelectChannel={store.selectChannel}
        isCategoryCollapsed={store.isCategoryCollapsed}
        onToggleCategory={store.toggleCategory}
      />
      <view
        style={{
          flexGrow: 1,
          flexDirection: "column",
          background: colors.mainBg,
          // min-height:0 is mandatory on a flex column whose children
          // include a scrollable region. Without it, flex-shrink on the
          // children defaults to "no smaller than content" — the message
          // stream then expands to fit all messages, pushes the composer
          // off-screen, and overflowY:scroll inside has nothing to clip
          // against.
          minHeight: 0,
        }}
      >
        {channel && (
          <MessageStream
            channel={channel}
            messages={store.messages}
            memberListOpen={store.memberListOpen}
            onToggleMemberList={store.toggleMemberList}
          />
        )}
        {channel && (
          <MessageInput
            channel={channel}
            draft={store.draft}
            onChange={store.setDraft}
            onSend={store.send}
          />
        )}
      </view>
      {store.memberListOpen && <MemberList users={USERS} themeName={themeName} />}
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
