# بروتوكول الغرفة (مختصر)
HTTP (Bearer): POST /rooms (+Idempotency-Key) · POST /rooms/join {code} · GET /rooms/{id} · POST /rooms/{id}/respond|start|leave|close|kick|settings|report
GET /rooms/{id}/messages?episode_id= · GET /rooms/{id}/moments?episode_id= · GET /rooms/{id}/ws (WebSocket، أعضاء فقط)
WS عميل→خادم: time, sync, play, pause, seek, ctl.request, ctl.respond, ready, buffering, chat, reaction, moment, wait.request|respond|back, episode.request|respond
WS خادم→عميل: snapshot, state(+cause), ack, time, chat, reaction, moment, ctl.request, ctl.denied, ready, buffering, wait.*, join.request, presence, kicked, room.closed
الحالة المرجعية: {status, position_ms, ref_ms (ساعة الخادم), state_version, start_at} + epoch (يزداد مع كل حلقة/بدء؛ أي أمر بـ epoch قديم يُتجاهل).
