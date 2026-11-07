from collections import deque


def merge_sort(data, key=None):
    if key is None:
        key = lambda x: x

    if len(data) <= 1:
        return data

    mid = len(data) // 2

    left = merge_sort(data[:mid], key)
    right = merge_sort(data[mid:], key)

    result = []
    i = j = 0

    while i < len(left) and j < len(right):
        if key(left[i]) <= key(right[j]):
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1

    result.extend(left[i:])
    result.extend(right[j:])

    return result


class WaitlistQueue:
    def __init__(self):
        self.queues = {}

    def join(self, event_id, user_id):
        if event_id not in self.queues:
            self.queues[event_id] = deque()

        if user_id in self.queues[event_id]:
            return list(self.queues[event_id]).index(user_id) + 1

        self.queues[event_id].append(user_id)
        return len(self.queues[event_id])

    def pop_next(self, event_id):
        if event_id not in self.queues or not self.queues[event_id]:
            return None

        return self.queues[event_id].popleft()