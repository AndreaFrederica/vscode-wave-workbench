# SPDX-License-Identifier: MPL-2.0
database -open waves -shm
probe -create -shm -database waves diff_tb -all -dynamic -memories -disable_packed_trans -depth all -packed 65536 -unpacked 65536
run
exit
